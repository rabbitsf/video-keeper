import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMp4Builder } from '../src/lib/mp4-defrag.js';

// Real mux.js output for a 2 s, two-segment stream (test/fixtures/seg0.ts, seg1.ts: 160x90 H.264 + AAC).
new Function(fs.readFileSync(new URL('../src/vendor/mux.js', import.meta.url), 'utf8')).call(globalThis);
const segments = ['seg0.ts', 'seg1.ts'].map((f) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url))));

function transmux() {
  const transmuxer = new globalThis.muxjs.mp4.Transmuxer();
  let init = null;
  const fragments = [];
  transmuxer.on('data', (s) => {
    init ||= s.initSegment;
    fragments.push(new Uint8Array(s.data));
  });
  for (const seg of segments) {
    transmuxer.push(seg);
    transmuxer.flush();
  }
  return { init, fragments };
}

// Minimal box walker for assertions.
function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let pos = start; pos + 8 <= end; ) {
    const size = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    out.push({ type, start: pos, body: pos + 8, end: pos + size });
    pos += size;
  }
  return out;
}
const child = (bytes, parent, type) => boxes(bytes, parent.body, parent.end).find((b) => b.type === type);
const path = (bytes, parent, ...types) => types.reduce((b, t) => b && child(bytes, b, t), parent);
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

function build() {
  const { init, fragments } = transmux();
  const mp4 = createMp4Builder();
  mp4.setInit(init);
  const parts = fragments.flatMap((f) => mp4.addFragment(f));
  const stored = parts.reduce((n, p) => n + p.length, 0);
  const header = mp4.finish(stored);
  const file = new Uint8Array(header.length + stored);
  file.set(header);
  parts.reduce((at, p) => (file.set(p, at), at + p.length), header.length);
  return { file, fragments };
}

test('builds a standard MP4: ftyp, moov, mdat — no fragments or mvex', () => {
  const { file } = build();
  const top = boxes(file);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  const moov = top[1];
  assert.equal(child(file, moov, 'mvex'), undefined);
  assert.equal(boxes(file, moov.body, moov.end).filter((b) => b.type === 'trak').length, 2);
});

test('durations are real (≈2 s), not mux.js\'s 0xFFFFFFFF placeholder', () => {
  const { file } = build();
  const moov = boxes(file)[1];
  const mvhd = child(file, moov, 'mvhd');
  const seconds = u32(file, mvhd.body + 16) / u32(file, mvhd.body + 12);
  assert.ok(seconds > 1.9 && seconds < 2.2, `movie duration ${seconds}s`);
  for (const trak of boxes(file, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const mdhd = path(file, trak, 'mdia', 'mdhd');
    const s = u32(file, mdhd.body + 16) / u32(file, mdhd.body + 12);
    assert.ok(s > 1.9 && s < 2.2, `track duration ${s}s`);
  }
});

test('sample tables index every sample, and chunk offsets point at the original sample bytes', () => {
  const { file, fragments } = build();
  const moov = boxes(file)[1];
  const mdat = boxes(file)[2];
  for (const trak of boxes(file, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const stbl = path(file, trak, 'mdia', 'minf', 'stbl');
    const stsz = child(file, stbl, 'stsz');
    const stco = child(file, stbl, 'stco');
    const count = u32(file, stsz.body + 8);
    const sizes = Array.from({ length: count }, (_, i) => u32(file, stsz.body + 12 + 4 * i));
    const chunkCount = u32(file, stco.body + 4);
    const offsets = Array.from({ length: chunkCount }, (_, i) => u32(file, stco.body + 8 + 4 * i));
    assert.ok(count > 0 && chunkCount === 2, 'one chunk per fragment per track');
    assert.ok(offsets.every((o) => o >= mdat.body && o < mdat.end), 'offsets inside mdat');
    // The first sample at the first offset must equal that sample's bytes in the fragment's mdat.
    const first = file.subarray(offsets[0], offsets[0] + sizes[0]);
    const inFragment = fragments.some((f) => {
      for (let i = 0; i + first.length <= f.length; i++) {
        if (f[i] === first[0] && f.subarray(i, i + first.length).every((b, k) => b === first[k])) return true;
      }
      return false;
    });
    assert.ok(inFragment, 'first sample bytes found in mux.js output');
  }
});

test('video keeps sync-sample (keyframe) table; audio has none (all sync)', () => {
  const { file } = build();
  const moov = boxes(file)[1];
  const traks = boxes(file, moov.body, moov.end).filter((b) => b.type === 'trak');
  const handler = (t) => String.fromCharCode(...file.subarray(path(file, t, 'mdia', 'hdlr').body + 8, path(file, t, 'mdia', 'hdlr').body + 12));
  const video = traks.find((t) => handler(t) === 'vide');
  const audio = traks.find((t) => handler(t) === 'soun');
  const stss = path(file, video, 'mdia', 'minf', 'stbl', 'stss');
  assert.ok(stss && u32(file, stss.body + 4) === 2, 'two keyframes (one per 1 s segment)');
  assert.equal(path(file, audio, 'mdia', 'minf', 'stbl', 'stss'), undefined);
});

test('handles feature-length sample counts (no call-stack overflow)', () => {
  // ~170k samples, like a 49-minute episode (the first real download failed with
  // "Maximum call stack size exceeded" when tables were built with spread arguments).
  const { init, fragments } = transmux();
  const mp4 = createMp4Builder();
  mp4.setInit(init);
  let stored = 0;
  for (let i = 0; i < 1200; i++) for (const f of fragments) for (const p of mp4.addFragment(f)) stored += p.length;
  const header = mp4.finish(stored);
  const moov = boxes(header)[1];
  const counts = boxes(header, moov.body, moov.end)
    .filter((b) => b.type === 'trak')
    .map((t) => u32(header, path(header, t, 'mdia', 'minf', 'stbl', 'stsz').body + 8));
  assert.ok(counts.reduce((a, b) => a + b, 0) > 150000, `sample count ${counts}`);
});
