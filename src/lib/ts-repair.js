// MPEG-TS repairs applied to HLS segments before transmuxing. Pure functions only (unit-tested).
//
// Some packagers cut segments in the middle of an audio PES packet and never send the rest.
// mux.js discards such a truncated PES entirely — every complete AAC frame in it — which shows up
// as ~100 ms audio holes at segment boundaries. trimTruncatedAudioPes() shortens that PES to its
// last complete ADTS frame instead, so only the genuinely missing partial frame is lost.

const PACKET = 188;
const ADTS_STREAM_TYPE = 0x0f;

const pidOf = (bytes, i) => ((bytes[i + 1] & 0x1f) << 8) | bytes[i + 2];
const startsUnit = (bytes, i) => (bytes[i + 1] & 0x40) !== 0;
const adaptationControl = (bytes, i) => (bytes[i + 3] >> 4) & 0x03;

function payloadOffset(bytes, i) {
  const afc = adaptationControl(bytes, i);
  if (!(afc & 0x01)) return PACKET; // No payload.
  return afc & 0x02 ? 5 + bytes[i + 4] : 4;
}

function isAligned(bytes) {
  return bytes.length >= PACKET && bytes.length % PACKET === 0 && bytes[0] === 0x47;
}

// PID of the first ADTS (AAC) elementary stream in the segment's PMT, or null.
export function findAdtsPid(bytes) {
  if (!isAligned(bytes)) return null;
  let pmtPid = null;
  for (let i = 0; i < bytes.length; i += PACKET) {
    const pid = pidOf(bytes, i);
    if (!startsUnit(bytes, i)) continue;
    const start = payloadOffset(bytes, i);
    if (start >= PACKET) continue;
    const section = i + start + 1 + bytes[i + start]; // Skip pointer_field.
    if (pid === 0 && pmtPid === null) {
      pmtPid = ((bytes[section + 10] & 0x1f) << 8) | bytes[section + 11];
    } else if (pid === pmtPid) {
      const sectionEnd = section + 3 + (((bytes[section + 1] & 0x0f) << 8) | bytes[section + 2]) - 4;
      let j = section + 12 + (((bytes[section + 10] & 0x0f) << 8) | bytes[section + 11]);
      while (j + 5 <= Math.min(sectionEnd, i + PACKET)) {
        if (bytes[j] === ADTS_STREAM_TYPE) return ((bytes[j + 1] & 0x1f) << 8) | bytes[j + 2];
        j += 5 + (((bytes[j + 3] & 0x0f) << 8) | bytes[j + 4]);
      }
      return null;
    }
  }
  return null;
}

// Does the segment's first packet on `pid` start a new PES? null if the segment has none.
export function startsWithNewPes(bytes, pid) {
  if (!isAligned(bytes)) return null;
  for (let i = 0; i < bytes.length; i += PACKET) {
    if (pidOf(bytes, i) === pid) return startsUnit(bytes, i);
  }
  return null;
}

// End offset (within data) of the last complete ADTS frame, or -1 if data doesn't start with ADTS.
function lastCompleteAdtsEnd(data) {
  let offset = 0;
  if (data.length < 7 || data[0] !== 0xff || (data[1] & 0xf6) !== 0xf0) return -1;
  while (offset + 7 <= data.length && data[offset] === 0xff && (data[offset + 1] & 0xf6) === 0xf0) {
    const frameLength = ((data[offset + 3] & 0x03) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    if (frameLength < 7 || offset + frameLength > data.length) break;
    offset += frameLength;
  }
  return offset;
}

// Rebuild a TS packet keeping only its first `keep` payload bytes (the rest becomes AF stuffing).
function shrinkPayload(bytes, i, keep) {
  const out = new Uint8Array(PACKET).fill(0xff);
  const afc = adaptationControl(bytes, i);
  const oldAf = afc & 0x02 ? bytes.subarray(i + 5, i + 5 + bytes[i + 4]) : new Uint8Array(0);
  const start = payloadOffset(bytes, i);
  out.set(bytes.subarray(i, i + 4));
  out[3] = (bytes[i + 3] & 0xcf) | 0x30; // Adaptation field + payload.
  out[4] = PACKET - 5 - keep; // adaptation_field_length
  if (out[4] > 0) {
    if (oldAf.length) out.set(oldAf, 5);
    else out[5] = 0x00; // AF flags: none; remaining AF bytes stay 0xFF stuffing.
  }
  out.set(bytes.subarray(i + start, i + start + keep), PACKET - keep);
  return out;
}

// If the segment's last PES on `pid` is shorter than its declared length, trim it to the last
// complete ADTS frame and fix PES_packet_length. Call only when no continuation follows.
// Returns the input unchanged when there is nothing (safe) to repair.
export function trimTruncatedAudioPes(bytes, pid) {
  if (!isAligned(bytes)) return bytes;
  const packets = [];
  for (let i = 0; i < bytes.length; i += PACKET) {
    if (pidOf(bytes, i) !== pid) continue;
    if (startsUnit(bytes, i)) packets.length = 0;
    if (startsUnit(bytes, i) || packets.length) packets.push(i);
  }
  if (!packets.length || payloadOffset(bytes, packets[0]) + 6 > PACKET) return bytes;

  const payloads = packets.map((i) => bytes.subarray(i + payloadOffset(bytes, i), i + PACKET));
  const pes = new Uint8Array(payloads.reduce((n, p) => n + p.length, 0));
  payloads.reduce((offset, p) => (pes.set(p, offset), offset + p.length), 0);
  if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return bytes;
  const declared = (pes[4] << 8) | pes[5];
  if (declared === 0 || 6 + declared <= pes.length) return bytes; // Unbounded or complete.

  const headerEnd = 9 + pes[8];
  const dataEnd = lastCompleteAdtsEnd(pes.subarray(headerEnd));
  if (dataEnd < 0) return bytes; // Not ADTS-aligned: leave it to mux.js.
  const keepTotal = headerEnd + dataEnd; // PES bytes to keep.

  const out = [];
  let packetIndex = 0;
  let consumed = 0;
  for (let i = 0; i < bytes.length; i += PACKET) {
    if (packetIndex < packets.length && packets[packetIndex] === i) {
      const size = payloads[packetIndex++].length;
      const keep = Math.max(0, Math.min(size, keepTotal - consumed));
      consumed += size;
      if (dataEnd === 0 || keep === 0) continue; // Drop packets past the cut (or an empty PES).
      out.push(keep === size ? bytes.subarray(i, i + PACKET) : shrinkPayload(bytes, i, keep));
    } else {
      out.push(bytes.subarray(i, i + PACKET));
    }
  }
  const result = new Uint8Array(out.length * PACKET);
  out.forEach((p, n) => result.set(p, n * PACKET));
  if (dataEnd > 0) {
    // Patch PES_packet_length. Only packets after the PES start are ever dropped, so the start
    // packet keeps its index.
    const at = packets[0] + payloadOffset(result, packets[0]);
    const length = keepTotal - 6;
    result[at + 4] = length >> 8;
    result[at + 5] = length & 0xff;
  }
  return result;
}
