import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVideoResource,
  sizeFromHeaders,
  filenameFor,
  formatBytes,
  formatResolution,
  formatDuration,
  normalizeUrl,
  isYtDlpPage,
} from '../src/lib/media.js';

test('isVideoResource accepts whole video files by extension or content type', () => {
  assert.equal(isVideoResource('https://a.com/clip.mp4'), true);
  assert.equal(isVideoResource('https://a.com/clip.WEBM?x=1'), true);
  assert.equal(isVideoResource('https://a.com/stream?id=9', 'video/mp4; codecs=x'), true);
});

test('isVideoResource rejects segments, manifests, non-http and non-video', () => {
  assert.equal(isVideoResource('https://a.com/seg1.ts', 'video/mp2t'), false);
  assert.equal(isVideoResource('https://a.com/chunk.m4s'), false);
  assert.equal(isVideoResource('https://a.com/index.m3u8'), false);
  assert.equal(isVideoResource('blob:https://a.com/123'), false);
  assert.equal(isVideoResource('https://a.com/page.html', 'text/html'), false);
});

test('sizeFromHeaders prefers Content-Range total over partial Content-Length', () => {
  assert.equal(
    sizeFromHeaders([
      { name: 'Content-Length', value: '1024' },
      { name: 'Content-Range', value: 'bytes 0-1023/5000000' },
    ]),
    5000000,
  );
  assert.equal(sizeFromHeaders([{ name: 'content-length', value: '42' }]), 42);
  assert.equal(sizeFromHeaders([]), null);
});

test('filenameFor uses URL basename, falls back to page title with mime extension', () => {
  assert.equal(filenameFor({ url: 'https://a.com/v/My%20Clip.mp4?sig=1' }), 'My Clip.mp4');
  assert.equal(
    filenameFor({ url: 'https://a.com/play?id=1', contentType: 'video/webm', pageTitle: 'Talk: A/B' }),
    'Talk_ A_B.webm',
  );
  assert.equal(filenameFor({ url: 'https://a.com/play' }), 'play.mp4');
  assert.equal(filenameFor({ url: 'https://a.com/hls/index.m3u8' }), 'index.mp4');
});

test('isVideoResource skips YouTube media pieces', () => {
  assert.equal(isVideoResource('https://rr3---sn-abc.googlevideo.com/videoplayback?itag=137', 'video/mp4'), false);
});

test('isYtDlpPage matches YouTube watch/shorts/short links only', () => {
  assert.equal(isYtDlpPage('https://www.youtube.com/watch?v=jNQXAC9IVRw'), true);
  assert.equal(isYtDlpPage('https://youtube.com/shorts/abc123'), true);
  assert.equal(isYtDlpPage('https://youtu.be/jNQXAC9IVRw'), true);
  assert.equal(isYtDlpPage('https://www.youtube.com/'), false);
  assert.equal(isYtDlpPage('https://vimeo.com/123'), false);
});

test('formatDuration', () => {
  assert.equal(formatDuration(75), '1:15');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(0), '');
});

test('formatting helpers', () => {
  assert.equal(formatBytes(42 * 1024 * 1024), '42 MB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(null), '');
  assert.equal(formatResolution(1920, 1080), '1080p');
  assert.equal(formatResolution(0, 0), '');
  assert.equal(normalizeUrl('https://a.com/x.mp4#t=10'), 'https://a.com/x.mp4');
});
