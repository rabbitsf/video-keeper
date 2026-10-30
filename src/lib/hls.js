// Canonical HLS playlist parsing. Pure functions only — shared by the background worker
// (detection) and the offscreen document (downloading), and unit-tested in Node.

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

export function isHlsResource(url, contentType = '') {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (HLS_CONTENT_TYPES.includes(type)) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

export function parseAttributes(text) {
  const attrs = {};
  for (const [, key, raw] of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

const ENCRYPTION_RANK = { none: 0, 'aes-128': 1, drm: 2 };

export function strongerEncryption(a = 'none', b = 'none') {
  return ENCRYPTION_RANK[a] >= ENCRYPTION_RANK[b] ? a : b;
}

// AES-128 is plain HLS encryption (key served alongside the stream); anything else is DRM.
function classifyKey(attrs) {
  const method = (attrs.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return 'none';
  const keyformat = (attrs.KEYFORMAT || 'identity').toLowerCase();
  return method === 'AES-128' && keyformat === 'identity' ? 'aes-128' : 'drm';
}

function parseByteRange(value, previousEnd) {
  const [length, offset] = value.split('@').map(Number);
  return { length, offset: Number.isFinite(offset) ? offset : previousEnd };
}

function parseResolution(value) {
  const match = /^(\d+)x(\d+)$/.exec(value || '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
}

// Parse a master or media playlist. All URIs are resolved against baseUrl.
export function parsePlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
  const resolve = (uri) => new URL(uri, baseUrl).toString();
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))
    ? parseMaster(lines, resolve)
    : parseMedia(lines, resolve);
}

function parseMaster(lines, resolve) {
  const variants = [];
  const audio = [];
  let encryption = 'none';
  let pending = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice(18));
      pending = {
        bandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH) || 0,
        ...parseResolution(attrs.RESOLUTION),
        codecs: attrs.CODECS || '',
        audioGroup: attrs.AUDIO || '',
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice(13));
      if (attrs.TYPE === 'AUDIO' && attrs.URI) {
        audio.push({ groupId: attrs['GROUP-ID'], name: attrs.NAME || '', url: resolve(attrs.URI) });
      }
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      encryption = strongerEncryption(encryption, classifyKey(parseAttributes(line.slice(19))));
    } else if (!line.startsWith('#') && pending) {
      variants.push({ ...pending, url: resolve(line) });
      pending = null;
    }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  const separateAudio = variants.some((v) => v.audioGroup && audio.some((a) => a.groupId === v.audioGroup));
  return { type: 'master', variants, audio, separateAudio, encryption };
}

function parseMedia(lines, resolve) {
  const segments = [];
  let mediaSequence = 0;
  let duration = 0;
  let segmentDuration = 0;
  let key = null;
  let map = null;
  let byteRange = null;
  let ended = false;
  let encryption = 'none';
  const rangeEnds = new Map(); // url -> end offset of the previous sub-range

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      segmentDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(11));
      const kind = classifyKey(attrs);
      encryption = strongerEncryption(encryption, kind);
      key = kind === 'none' ? null : { method: kind, url: attrs.URI ? resolve(attrs.URI) : '', iv: attrs.IV || '' };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(11));
      map = { url: resolve(attrs.URI) };
      if (attrs.BYTERANGE) map.byteRange = parseByteRange(attrs.BYTERANGE, 0);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      ended = true;
    } else if (!line.startsWith('#')) {
      const url = resolve(line);
      const segment = { url, duration: segmentDuration, sequence: mediaSequence + segments.length, key, map };
      if (byteRange) {
        segment.byteRange = parseByteRange(byteRange, rangeEnds.get(url) || 0);
        rangeEnds.set(url, segment.byteRange.offset + segment.byteRange.length);
        byteRange = null;
      }
      segments.push(segment);
      duration += segmentDuration;
      segmentDuration = 0;
    }
  }
  return {
    type: 'media',
    segments,
    duration,
    live: !ended,
    encryption,
    map: segments[0]?.map || map,
  };
}

// AES-128 IV: explicit hex IV, else the segment's media sequence number (big-endian, 16 bytes).
export function ivForSegment(segment) {
  const iv = new Uint8Array(16);
  const hex = segment.key?.iv?.replace(/^0x/i, '');
  if (hex) {
    const padded = hex.padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    return iv;
  }
  let n = BigInt(segment.sequence);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}
