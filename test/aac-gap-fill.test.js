import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentFramesBefore, fillAdtsGaps, frameTicks } from '../src/lib/aac-gap-fill.js';

const TICKS = 1920; // 1024 samples at 48 kHz in 90 kHz clock ticks
const frame = (dts, extra = {}) => ({
  dts, pts: dts, samplerate: 48000, sampleCount: 1024, audioobjecttype: 2, channelcount: 2,
  data: new Uint8Array([1, 2, 3]), ...extra,
});

test('frameTicks is the AAC frame duration in 90 kHz ticks', () => {
  assert.equal(frameTicks(frame(0)), TICKS);
});

test('silentFramesBefore fills a gap with evenly spaced silent frames ending at the real frame', () => {
  const silent = silentFramesBefore(10 * TICKS, frame(15 * TICKS));
  assert.deepEqual(silent.map((f) => f.dts), [10, 11, 12, 13, 14].map((n) => n * TICKS));
  assert.ok(silent.every((f) => f.data.length === 9 && f.pts === f.dts && f.channelcount === 2));
});

test('silentFramesBefore ignores contiguous, overlapping, sub-frame, huge and unfillable gaps', () => {
  assert.deepEqual(silentFramesBefore(null, frame(0)), []);
  assert.deepEqual(silentFramesBefore(10 * TICKS, frame(10 * TICKS)), []);
  assert.deepEqual(silentFramesBefore(10 * TICKS, frame(9 * TICKS)), []);
  assert.deepEqual(silentFramesBefore(10 * TICKS, frame(10 * TICKS + 400)), []); // jitter < half a frame
  assert.deepEqual(silentFramesBefore(0, frame(3 * 90000)), []); // 3 s jump: discontinuity
  assert.deepEqual(silentFramesBefore(0, frame(5 * TICKS, { channelcount: 6 })), []); // no silent frame
  assert.deepEqual(silentFramesBefore(0, frame(5 * TICKS, { audioobjecttype: 5 })), []); // not AAC-LC
});

test('fillAdtsGaps inserts silent frames into a stream\'s data events', () => {
  const seen = [];
  const stream = { trigger(type, f) { if (type === 'data') seen.push(f); } };
  fillAdtsGaps(stream);
  for (const n of [0, 1, 2, 5, 6]) stream.trigger('data', frame(n * TICKS));
  stream.trigger('done');
  assert.deepEqual(seen.map((f) => f.dts / TICKS), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(seen.map((f) => f.data.length === 9), [false, false, false, true, true, false, false]);
});
