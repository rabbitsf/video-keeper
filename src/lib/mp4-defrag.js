// Rebuild mux.js's fragmented MP4 (init moov + moof/mdat pairs) as a standard MP4 with one
// sample table, like ffmpeg writes. AVFoundation (QuickTime, Safari, Photos) misreads mux.js's
// fragmented output: it reports a ~25 h duration and stops decoding audio after the first fragment.
//
// Usage: const mp4 = createMp4Builder(); mp4.setInit(initSegment);
//        for each fragment: store every Uint8Array returned by mp4.addFragment(fragment) (in order);
//        finally: new Blob([mp4.finish(storedByteCount), ...stored]).
// Sample bytes are never copied or re-ordered: the returned parts are the mdat payload, in order.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'dinf', 'edts']);
const MAX_U32 = 0xffffffff;

// --- box reading / writing -------------------------------------------------------------------

function readBoxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    const box = { type, start: pos, end: pos + size, payload: bytes.subarray(pos + header, pos + size) };
    if (CONTAINERS.has(type)) box.children = readBoxes(bytes, pos + header, pos + size);
    boxes.push(box);
    pos += size;
  }
  return boxes;
}

const find = (boxes, type) => boxes?.find((b) => b.type === type);
const findAll = (boxes, type) => boxes?.filter((b) => b.type === type) || [];

function box(type, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Full-box payload with version/flags followed by big-endian fields: an array of [bits, value].
// Takes an array (not rest args): sample tables have one entry per frame, far beyond the
// engine's argument limit for a feature-length video.
function fields(version, flags, values) {
  const size = 4 + values.reduce((n, [bits]) => n + bits / 8, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, ((version & 0xff) << 24) | (flags & 0xffffff));
  let offset = 4;
  for (const [bits, value] of values) {
    if (bits === 64) view.setBigUint64(offset, BigInt(value));
    else if (bits === 32) view.setUint32(offset, value >>> 0);
    else view.setUint8(offset, value);
    offset += bits / 8;
  }
  return out;
}

const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

// Replace the duration in an mvhd/tkhd/mdhd payload, upgrading to version 1 when it needs 64 bits.
function withDuration(payload, kind, duration) {
  const v1 = payload[0] === 1;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // Field layout up to and including duration, for each version.
  const pre = kind === 'tkhd' ? (v1 ? [8, 8, 4, 4] : [4, 4, 4, 4]) : v1 ? [8, 8, 4] : [4, 4, 4];
  const head = 4 + pre.reduce((a, b) => a + b, 0);
  const tail = payload.subarray(head + (v1 ? 8 : 4));
  if (!v1 && duration <= MAX_U32) {
    const out = payload.slice();
    new DataView(out.buffer).setUint32(head, duration);
    return out;
  }
  // Rebuild as version 1: 64-bit times and duration.
  const read = (i) => {
    let offset = 4;
    for (let k = 0; k < i; k++) offset += pre[k];
    return pre[i] === 8 ? Number(view.getBigUint64(offset)) : view.getUint32(offset);
  };
  const values = pre.map((_, i) => [kind === 'tkhd' && i >= 2 ? 32 : i < 2 ? 64 : 32, read(i)]);
  const head1 = fields(1, view.getUint32(0) & 0xffffff, [...values, [64, duration]]);
  const out = new Uint8Array(head1.length + tail.length);
  out.set(head1);
  out.set(tail, head1.length);
  return out;
}

// --- builder ---------------------------------------------------------------------------------

export function createMp4Builder() {
  let init = null;
  const tracks = new Map(); // trackId -> { timescale, samples: [], chunks: [], nextDts, startDts, defaults }
  let stored = 0;

  function setInit(bytes) {
    const top = readBoxes(bytes);
    const moov = find(top, 'moov');
    if (!moov) throw new Error('Init segment has no moov');
    init = { ftyp: find(top, 'ftyp'), moov };
    for (const trak of findAll(moov.children, 'trak')) {
      const tkhd = find(trak.children, 'tkhd').payload;
      const id = u32(tkhd, tkhd[0] === 1 ? 20 : 12);
      const mdhd = find(find(trak.children, 'mdia').children, 'mdhd').payload;
      const handler = find(find(trak.children, 'mdia').children, 'hdlr').payload;
      tracks.set(id, {
        trak,
        timescale: u32(mdhd, mdhd[0] === 1 ? 20 : 12),
        video: String.fromCharCode(...handler.subarray(8, 12)) === 'vide',
        samples: [],
        chunks: [],
        nextDts: null,
        startDts: null,
        defaults: { duration: 0, size: 0, flags: 0 },
      });
    }
    for (const trex of findAll(find(moov.children, 'mvex')?.children, 'trex')) {
      const track = tracks.get(u32(trex.payload, 4));
      if (track) track.defaults = { duration: u32(trex.payload, 12), size: u32(trex.payload, 16), flags: u32(trex.payload, 20) };
    }
  }

  // Record one moof/mdat fragment; returns the sample data parts to store, in order.
  function addFragment(bytes) {
    if (!init) throw new Error('setInit() must be called first');
    const parts = [];
    for (const moof of findAll(readBoxes(bytes), 'moof')) {
      for (const traf of findAll(moof.children, 'traf')) {
        const tfhd = find(traf.children, 'tfhd').payload;
        const track = tracks.get(u32(tfhd, 4));
        if (!track) continue;
        const tfhdFlags = u32(tfhd, 0) & 0xffffff;
        let at = 8;
        let base = moof.start;
        if (tfhdFlags & 0x01) {
          base = Number(new DataView(tfhd.buffer, tfhd.byteOffset).getBigUint64(at));
          at += 8;
        }
        if (tfhdFlags & 0x02) at += 4;
        const defaults = { ...track.defaults };
        if (tfhdFlags & 0x08) (defaults.duration = u32(tfhd, at)), (at += 4);
        if (tfhdFlags & 0x10) (defaults.size = u32(tfhd, at)), (at += 4);
        if (tfhdFlags & 0x20) defaults.flags = u32(tfhd, at);

        const tfdt = find(traf.children, 'tfdt')?.payload;
        if (tfdt) {
          const dts = tfdt[0] === 1 ? Number(new DataView(tfdt.buffer, tfdt.byteOffset).getBigUint64(4)) : u32(tfdt, 4);
          if (track.nextDts === null) track.startDts = dts;
          else if (dts > track.nextDts && track.samples.length) track.samples[track.samples.length - 1].duration += dts - track.nextDts;
          track.nextDts = Math.max(track.nextDts ?? dts, dts);
        }

        track.nextDts ??= 0;
        for (const trun of findAll(traf.children, 'trun')) {
          const p = trun.payload;
          const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
          const flags = view.getUint32(0) & 0xffffff;
          const count = view.getUint32(4);
          let offset = 8;
          let dataStart = base;
          if (flags & 0x01) (dataStart = base + view.getInt32(offset)), (offset += 4);
          let firstFlags = null;
          if (flags & 0x04) (firstFlags = view.getUint32(offset)), (offset += 4);
          let size = 0;
          for (let i = 0; i < count; i++) {
            const sample = { duration: defaults.duration, size: defaults.size, flags: defaults.flags, cto: 0 };
            if (flags & 0x100) (sample.duration = view.getUint32(offset)), (offset += 4);
            if (flags & 0x200) (sample.size = view.getUint32(offset)), (offset += 4);
            if (flags & 0x400) (sample.flags = view.getUint32(offset)), (offset += 4);
            else if (i === 0 && firstFlags !== null) sample.flags = firstFlags;
            if (flags & 0x800) (sample.cto = p[0] === 1 ? view.getInt32(offset) : view.getUint32(offset)), (offset += 4);
            track.samples.push({
              duration: sample.duration,
              size: sample.size,
              // Audio samples are all sync; mux.js's trex default marks them non-sync.
              sync: !track.video || !(sample.flags & 0x10000),
              cto: sample.cto,
            });
            track.nextDts += sample.duration;
            size += sample.size;
          }
          if (!count) continue;
          parts.push(bytes.subarray(dataStart, dataStart + size));
          track.chunks.push({ offset: stored, count });
          stored += size;
        }
      }
    }
    return parts;
  }

  function sampleTables(track, base, wide) {
    const { samples, chunks } = track;
    const runs = (values) => {
      const out = [];
      for (const v of values) {
        if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
        else out.push([1, v]);
      }
      return out;
    };
    const stts = runs(samples.map((s) => s.duration));
    const ctsRuns = runs(samples.map((s) => s.cto));
    const negativeCts = samples.some((s) => s.cto < 0);
    const syncs = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
    const stscRuns = [];
    chunks.forEach((c, i) => {
      if (!stscRuns.length || stscRuns[stscRuns.length - 1][1] !== c.count) stscRuns.push([i + 1, c.count]);
    });
    const boxes = [
      box('stts', fields(0, 0, [[32, stts.length], ...stts.flatMap(([n, d]) => [[32, n], [32, d]])])),
    ];
    if (ctsRuns.length > 1 || ctsRuns[0]?.[1] !== 0) {
      boxes.push(box('ctts', fields(negativeCts ? 1 : 0, 0, [[32, ctsRuns.length], ...ctsRuns.flatMap(([n, c]) => [[32, n], [32, c]])])));
    }
    if (syncs.length < samples.length) boxes.push(box('stss', fields(0, 0, [[32, syncs.length], ...syncs.map((s) => [32, s])])));
    boxes.push(
      box('stsc', fields(0, 0, [[32, stscRuns.length], ...stscRuns.flatMap(([first, n]) => [[32, first], [32, n], [32, 1]])])),
      box('stsz', fields(0, 0, [[32, 0], [32, samples.length], ...samples.map((s) => [32, s.size])])),
      wide
        ? box('co64', fields(0, 0, [[32, chunks.length], ...chunks.map((c) => [64, base + c.offset])]))
        : box('stco', fields(0, 0, [[32, chunks.length], ...chunks.map((c) => [32, base + c.offset])])),
    );
    return boxes;
  }

  function buildMoov(base, wide) {
    const moov = init.moov;
    const mvhd = find(moov.children, 'mvhd').payload;
    const movieTimescale = u32(mvhd, mvhd[0] === 1 ? 20 : 12);
    let movieDuration = 0;
    const traks = [];
    for (const track of tracks.values()) {
      if (!track.samples.length) continue;
      const mediaDuration = track.samples.reduce((n, s) => n + s.duration, 0);
      const startOffset = Math.round(((track.startDts || 0) * movieTimescale) / track.timescale);
      const duration = Math.round((mediaDuration * movieTimescale) / track.timescale) + startOffset;
      movieDuration = Math.max(movieDuration, duration);
      const trakParts = [];
      for (const child of track.trak.children) {
        if (child.type === 'tkhd') trakParts.push(box('tkhd', withDuration(child.payload, 'tkhd', duration)));
        else if (child.type === 'edts') continue;
        else if (child.type === 'mdia') {
          if (startOffset > 0) {
            // Delay the track by an empty edit so it starts at its first fragment's time.
            const mediaEdit = Math.round((mediaDuration * movieTimescale) / track.timescale);
            trakParts.push(box('edts', box('elst', fields(0, 0, [[32, 2], [32, startOffset], [32, MAX_U32], [32, 0x10000], [32, mediaEdit], [32, 0], [32, 0x10000]]))));
          }
          const mdia = [];
          for (const m of child.children) {
            if (m.type === 'mdhd') mdia.push(box('mdhd', withDuration(m.payload, 'mdhd', mediaDuration)));
            else if (m.type === 'minf') {
              const minf = m.children.map((n) => {
                if (n.type !== 'stbl') return box(n.type, n.children ? new Uint8Array(0) : n.payload, ...(n.children || []).map((c) => box(c.type, c.payload)));
                const stsd = find(n.children, 'stsd');
                return box('stbl', box('stsd', stsd.payload), ...sampleTables(track, base, wide));
              });
              mdia.push(box('minf', ...minf));
            } else mdia.push(box(m.type, m.payload));
          }
          trakParts.push(box('mdia', ...mdia));
        } else trakParts.push(box(child.type, child.payload));
      }
      traks.push(box('trak', ...trakParts));
    }
    return box('moov', box('mvhd', withDuration(mvhd, 'mvhd', movieDuration)), ...traks);
  }

  // Header bytes (ftyp + moov + mdat header) to place before the stored sample data.
  function finish(storedBytes = stored) {
    if (!init) throw new Error('No init segment');
    const ftyp = init.ftyp ? box('ftyp', init.ftyp.payload) : box('ftyp', new TextEncoder().encode('isom\0\0\x02\0isomiso2avc1mp41'));
    const largeMdat = storedBytes + 8 > MAX_U32;
    const mdatHeaderSize = largeMdat ? 16 : 8;
    // Build once to measure the moov, then again with real chunk offsets (same size).
    let wide = false;
    let moovSize = buildMoov(0, wide).length;
    let base = ftyp.length + moovSize + mdatHeaderSize;
    if (base + storedBytes > MAX_U32) {
      wide = true;
      moovSize = buildMoov(0, wide).length;
      base = ftyp.length + moovSize + mdatHeaderSize;
    }
    const moov = buildMoov(base, wide);
    const mdatHeader = new Uint8Array(mdatHeaderSize);
    const view = new DataView(mdatHeader.buffer);
    if (largeMdat) {
      view.setUint32(0, 1);
      view.setBigUint64(8, BigInt(storedBytes + 16));
    } else {
      view.setUint32(0, storedBytes + 8);
    }
    mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
    const header = new Uint8Array(ftyp.length + moov.length + mdatHeaderSize);
    header.set(ftyp);
    header.set(moov, ftyp.length);
    header.set(mdatHeader, ftyp.length + moov.length);
    return header;
  }

  return { setInit, addFragment, finish, get storedBytes() { return stored; } };
}
