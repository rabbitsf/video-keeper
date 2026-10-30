import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAdtsPid, startsWithNewPes, trimTruncatedAudioPes } from '../src/lib/ts-repair.js';

const VIDEO_PID = 256;
const AUDIO_PID = 257;

// A TS packet carrying `payload` (≤184 bytes); short payloads are padded with AF stuffing.
function packet(pid, pusi, payload) {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  if (payload.length === 184) {
    p[3] = 0x10;
    p.set(payload, 4);
  } else {
    p[3] = 0x30;
    p[4] = 183 - payload.length;
    if (p[4] > 0) p[5] = 0x00;
    p.set(payload, 188 - payload.length);
  }
  return p;
}

function section(tableId, body) {
  const length = body.length + 5 + 4; // + header after length + CRC
  return [0x00, tableId, 0xb0 | (length >> 8), length & 0xff, 0x00, 0x01, 0xc1, 0x00, 0x00, ...body, 0, 0, 0, 0];
}

const PAT = packet(0, true, new Uint8Array(section(0x00, [0x00, 0x01, 0xf0, 0x00]))); // program 1 → PMT 0x1000
const PMT = packet(0x1000, true, new Uint8Array(section(0x02, [
  0xe1, 0x00, 0xf0, 0x00, // PCR PID 256, no program info
  0x1b, 0xe1, 0x00, 0xf0, 0x00, // H.264 on 256
  0x0f, 0xe1, 0x01, 0xf0, 0x00, // ADTS on 257
])));

function adtsFrame(length, fill) {
  const f = new Uint8Array(length).fill(fill);
  f.set([0xff, 0xf1, 0x50, 0x80 | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]);
  return f;
}

function audioPes(frames) {
  const data = frames.reduce((all, f) => [...all, ...f], []);
  const header = [0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1];
  const length = header.length - 6 + data.length;
  header[4] = length >> 8;
  header[5] = length & 0xff;
  return new Uint8Array([...header, ...data]);
}

// Split a PES into TS packets on `pid`.
function packetize(pid, pes) {
  const out = [];
  for (let i = 0; i < pes.length; i += 184) out.push(packet(pid, i === 0, pes.subarray(i, i + 184)));
  return out;
}

const join = (packets) => {
  const bytes = new Uint8Array(packets.length * 188);
  packets.forEach((p, i) => bytes.set(p, i * 188));
  return bytes;
};

// Reassemble the payload of the last PES on `pid`.
function lastPes(bytes, pid) {
  let parts = [];
  for (let i = 0; i < bytes.length; i += 188) {
    if ((((bytes[i + 1] & 0x1f) << 8) | bytes[i + 2]) !== pid) continue;
    const afc = (bytes[i + 3] >> 4) & 3;
    const start = afc & 2 ? 5 + bytes[i + 4] : 4;
    if (bytes[i + 1] & 0x40) parts = [];
    parts.push(...bytes.subarray(i + start, i + 188));
  }
  return new Uint8Array(parts);
}

const frames = [adtsFrame(150, 1), adtsFrame(150, 2), adtsFrame(150, 3), adtsFrame(150, 4)];
const fullPes = audioPes(frames); // 14 + 600 bytes → 4 packets

test('findAdtsPid reads the AAC PID from PAT/PMT', () => {
  assert.equal(findAdtsPid(join([PAT, PMT])), AUDIO_PID);
  assert.equal(findAdtsPid(new Uint8Array(10)), null);
});

test('startsWithNewPes reports PES continuation for a PID', () => {
  const pesPackets = packetize(AUDIO_PID, fullPes);
  assert.equal(startsWithNewPes(join([PAT, PMT, pesPackets[0]]), AUDIO_PID), true);
  assert.equal(startsWithNewPes(join([PAT, PMT, pesPackets[1]]), AUDIO_PID), false);
  assert.equal(startsWithNewPes(join([PAT, PMT]), AUDIO_PID), null);
});

test('trimTruncatedAudioPes keeps whole frames of a truncated PES and fixes its length', () => {
  const pesPackets = packetize(AUDIO_PID, fullPes);
  // Segment ends after 2 of 4 packets: 368 bytes = header(14) + 2 frames(300) + 54 bytes of frame 3.
  const segment = join([PAT, PMT, packet(VIDEO_PID, true, new Uint8Array(184)), ...pesPackets.slice(0, 2)]);
  const repaired = trimTruncatedAudioPes(segment, AUDIO_PID);
  assert.equal(repaired.length % 188, 0);
  const pes = lastPes(repaired, AUDIO_PID);
  assert.deepEqual([...pes], [...audioPes(frames.slice(0, 2))], 'PES is header + 2 complete frames');
  assert.equal(((pes[4] << 8) | pes[5]) + 6, pes.length, 'declared length matches');
  assert.deepEqual([...repaired.subarray(0, 3 * 188)], [...segment.subarray(0, 3 * 188)], 'other packets untouched');
});

test('trimTruncatedAudioPes drops packets that hold only the partial frame', () => {
  const pesPackets = packetize(AUDIO_PID, fullPes);
  // 3 of 4 packets: 552 bytes = header + 3 frames (464) + 88 bytes of frame 4 → keep 3 frames.
  const repaired = trimTruncatedAudioPes(join([PAT, PMT, ...pesPackets.slice(0, 3)]), AUDIO_PID);
  assert.deepEqual([...lastPes(repaired, AUDIO_PID)], [...audioPes(frames.slice(0, 3))]);
});

test('trimTruncatedAudioPes leaves complete, unbounded and non-ADTS PES alone', () => {
  const complete = join([PAT, PMT, ...packetize(AUDIO_PID, fullPes)]);
  assert.equal(trimTruncatedAudioPes(complete, AUDIO_PID), complete);

  const unbounded = audioPes(frames);
  unbounded[4] = unbounded[5] = 0;
  const unboundedSegment = join([PAT, PMT, ...packetize(AUDIO_PID, unbounded).slice(0, 2)]);
  assert.equal(trimTruncatedAudioPes(unboundedSegment, AUDIO_PID), unboundedSegment);

  const notAdts = audioPes([new Uint8Array(600).fill(7)]);
  const notAdtsSegment = join([PAT, PMT, ...packetize(AUDIO_PID, notAdts).slice(0, 2)]);
  assert.equal(trimTruncatedAudioPes(notAdtsSegment, AUDIO_PID), notAdtsSegment);
});
