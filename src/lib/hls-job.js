// Canonical HLS job runner: fetch, decrypt and join segments into one Blob.
// Runs wherever blob: URLs can be created — Chrome's offscreen document (service workers can't)
// or Firefox's background page. Callers supply report() for job-state patches and
// deliver() for the finished Blob; this module owns cancellation by job id.
// Requires mux.js loaded as a classic script beforehand (global `muxjs`).

import { parsePlaylist, ivForSegment } from './hls.js';
import { findAdtsPid, startsWithNewPes, trimTruncatedAudioPes } from './ts-repair.js';
import { fillAdtsGaps } from './aac-gap-fill.js';
import { createMp4Builder } from './mp4-defrag.js';

const CONCURRENCY = 6;
const RETRIES = 3;
const PROGRESS_INTERVAL_MS = 500;
const PARTS_PER_BLOB_FLUSH = 50; // Fold parts into a Blob periodically so the browser can page them to disk.

const controllers = new Map(); // jobId -> AbortController

export function cancelHlsJob(jobId) {
  controllers.get(jobId)?.abort();
}

export async function runHlsJob(job, { report, deliver }) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const { signal } = controller;
  try {
    const playlist = parsePlaylist(await fetchText(job.playlistUrl, signal), job.playlistUrl);
    if (playlist.type !== 'media') throw new Error('Expected a media playlist');
    if (playlist.live) throw new Error('Live streams are not supported');
    if (playlist.encryption === 'drm') throw new Error('DRM-protected stream');

    const total = playlist.segments.length;
    report({ status: 'downloading', done: 0, total, bytes: 0 });

    // fMP4 segments are already MP4 fragments; MPEG-TS needs transmuxing.
    const sink = playlist.map ? rawSink('video/mp4') : transmuxSink();
    if (playlist.map) sink.push(await fetchBytes(playlist.map, signal));

    const keys = new Map();
    let done = 0;
    let bytes = 0;
    let lastReport = 0;
    await forEachInOrder(
      playlist.segments,
      (segment) => fetchSegment(segment, keys, signal),
      (data) => {
        sink.push(data);
        done++;
        bytes += data.byteLength;
        if (Date.now() - lastReport > PROGRESS_INTERVAL_MS) {
          lastReport = Date.now();
          report({ done, bytes });
        }
      },
    );

    const { blob, extension } = sink.finish();
    const filename = extension ? job.filename.replace(/\.[^.]+$/, `.${extension}`) : job.filename;
    report({ status: 'saving', done, bytes: blob.size });
    await deliver(blob, filename);
  } catch (err) {
    report(signal.aborted ? { status: 'cancelled' } : { status: 'error', error: err.message });
  } finally {
    controllers.delete(job.id);
  }
}

// Load up to CONCURRENCY items ahead, but hand results to consume() strictly in order.
async function forEachInOrder(items, load, consume) {
  const pending = new Map();
  let next = 0;
  for (let i = 0; i < items.length; i++) {
    while (next < items.length && next < i + CONCURRENCY) {
      const promise = load(items[next]);
      promise.catch(() => {}); // Surfaced when awaited below.
      pending.set(next++, promise);
    }
    const data = await pending.get(i);
    pending.delete(i);
    consume(data);
  }
}

async function withRetries(fn, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted || attempt >= RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function fetchOk(url, signal, headers) {
  const response = await fetch(url, { signal, headers, credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

async function fetchText(url, signal) {
  return (await withRetries(() => fetchOk(url, signal), signal)).text();
}

async function fetchBytes({ url, byteRange }, signal) {
  const headers = byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : {};
  return withRetries(async () => new Uint8Array(await (await fetchOk(url, signal, headers)).arrayBuffer()), signal);
}

async function fetchSegment(segment, keys, signal) {
  const data = await fetchBytes(segment, signal);
  if (segment.key?.method !== 'aes-128') return data;
  if (!keys.has(segment.key.url)) {
    keys.set(
      segment.key.url,
      fetchBytes({ url: segment.key.url }, signal).then((raw) =>
        crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']),
      ),
    );
  }
  const key = await keys.get(segment.key.url);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivForSegment(segment) }, key, data));
}

function rawSink(type, extension = null) {
  let blob = new Blob([], { type });
  let parts = [];
  return {
    push(data) {
      parts.push(data);
      if (parts.length >= PARTS_PER_BLOB_FLUSH) {
        blob = new Blob([blob, ...parts], { type });
        parts = [];
      }
    },
    finish() {
      return { blob: new Blob([blob, ...parts], { type }), extension };
    },
  };
}

// mux.js output (init + moof/mdat fragments) → one standard MP4 (lib/mp4-defrag.js), because
// QuickTime/AVFoundation misreads mux.js's fragmented files (wrong duration, audio stops early).
function standardMp4Sink(initSegment) {
  const mp4 = createMp4Builder();
  mp4.setInit(initSegment);
  const payload = rawSink('application/octet-stream');
  return {
    push(fragment) {
      for (const part of mp4.addFragment(fragment)) payload.push(part);
    },
    finish() {
      const { blob } = payload.finish();
      return { blob: new Blob([mp4.finish(blob.size), blob], { type: 'video/mp4' }), extension: null };
    },
  };
}

// MPEG-TS → MP4 via mux.js, one segment at a time. Each segment is held until the next
// one arrives so that an audio PES cut short at its end (and never continued) can be trimmed to
// whole AAC frames first — otherwise mux.js drops the entire PES (see lib/ts-repair.js).
// Audio timeline gaps are filled with silence so audio keeps its real timing (lib/aac-gap-fill.js).
// If the first segment yields no MP4 output (e.g. an unsupported codec), fall back to raw .ts.
function transmuxSink() {
  const transmuxer = new globalThis.muxjs.mp4.Transmuxer();
  // Build the TS pipeline now (push() reuses it) so the AAC parser can be wrapped before any data.
  transmuxer.setupTsPipeline();
  fillAdtsGaps(transmuxer.transmuxPipeline_.adtsStream);
  let out = null;
  let produced = [];
  transmuxer.on('data', (segment) => {
    out ||= standardMp4Sink(segment.initSegment);
    produced.push(segment.data);
  });
  let fallback = null;
  let pending = null;
  let audioPid = null;

  function transmux(data, next) {
    if (fallback) return fallback.push(data);
    audioPid ??= findAdtsPid(data);
    // The next segment doesn't continue our last audio PES (or there is no next segment).
    const truncatedTail = audioPid !== null && startsWithNewPes(next ?? new Uint8Array(0), audioPid) !== false;
    transmuxer.push(truncatedTail ? trimTruncatedAudioPes(data, audioPid) : data);
    transmuxer.flush();
    if (!out) {
      fallback = rawSink('video/mp2t', 'ts');
      fallback.push(data);
      return;
    }
    for (const chunk of produced) out.push(chunk);
    produced = [];
  }

  return {
    push(data) {
      if (pending) transmux(pending, data);
      pending = data;
    },
    finish() {
      if (pending) transmux(pending, null);
      pending = null;
      return (fallback || out || rawSink('video/mp4')).finish();
    },
  };
}
