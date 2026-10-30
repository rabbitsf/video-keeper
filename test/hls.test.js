import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHlsResource, parsePlaylist, ivForSegment, strongerEncryption } from '../src/lib/hls.js';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
https://cdn.example.com/hi/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4.0,
seg0.ts
#EXTINF:3.5,
seg1.ts
#EXT-X-ENDLIST
`;

test('isHlsResource detects by extension or content type', () => {
  assert.equal(isHlsResource('https://a.com/x/master.m3u8?t=1'), true);
  assert.equal(isHlsResource('https://a.com/play', 'application/vnd.apple.mpegurl'), true);
  assert.equal(isHlsResource('https://a.com/clip.mp4', 'video/mp4'), false);
  assert.equal(isHlsResource('blob:https://a.com/1'), false);
});

test('parsePlaylist: master playlist variants sorted best-first with resolved URLs', () => {
  const p = parsePlaylist(MASTER, 'https://a.com/v/master.m3u8');
  assert.equal(p.type, 'master');
  assert.deepEqual(
    p.variants.map((v) => [v.height, v.url]),
    [
      [720, 'https://cdn.example.com/hi/index.m3u8'],
      [360, 'https://a.com/v/low/index.m3u8'],
    ],
  );
  assert.equal(p.separateAudio, false);
});

test('parsePlaylist: master with separate audio rendition is flagged', () => {
  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="aud"
video.m3u8
`;
  assert.equal(parsePlaylist(text, 'https://a.com/m.m3u8').separateAudio, true);
});

test('parsePlaylist: media playlist segments, duration, key, sequence', () => {
  const p = parsePlaylist(MEDIA, 'https://a.com/v/hi.m3u8');
  assert.equal(p.type, 'media');
  assert.equal(p.live, false);
  assert.equal(p.encryption, 'aes-128');
  assert.equal(p.duration, 7.5);
  assert.deepEqual(
    p.segments.map((s) => [s.url, s.sequence, s.key.url]),
    [
      ['https://a.com/v/seg0.ts', 5, 'https://a.com/v/key.bin'],
      ['https://a.com/v/seg1.ts', 6, 'https://a.com/v/key.bin'],
    ],
  );
});

test('parsePlaylist: live (no ENDLIST), fMP4 map, byte ranges, DRM keys', () => {
  const text = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:2,
#EXT-X-BYTERANGE:100@0
all.mp4
#EXTINF:2,
#EXT-X-BYTERANGE:50
all.mp4
`;
  const p = parsePlaylist(text, 'https://a.com/x.m3u8');
  assert.equal(p.live, true);
  assert.equal(p.encryption, 'drm');
  assert.equal(p.map.url, 'https://a.com/init.mp4');
  assert.deepEqual(p.segments.map((s) => s.byteRange), [
    { length: 100, offset: 0 },
    { length: 50, offset: 100 },
  ]);
});

test('parsePlaylist rejects non-playlists', () => {
  assert.throws(() => parsePlaylist('<html>', 'https://a.com/'), /Not an HLS playlist/);
});

test('ivForSegment uses explicit IV or sequence number', () => {
  assert.deepEqual([...ivForSegment({ sequence: 258, key: { iv: '' } })].slice(14), [1, 2]);
  const iv = ivForSegment({ sequence: 0, key: { iv: '0x000102030405060708090A0B0C0D0E0F' } });
  assert.deepEqual([...iv], [...Array(16).keys()]);
});

test('strongerEncryption ranks none < aes-128 < drm', () => {
  assert.equal(strongerEncryption('none', 'aes-128'), 'aes-128');
  assert.equal(strongerEncryption('drm', 'aes-128'), 'drm');
});
