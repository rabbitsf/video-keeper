// native/host.py, driven over the real native messaging protocol with a fake yt-dlp.
// Runs under macOS's /usr/bin/python3 (3.9) because host.py must stay compatible with it.
// The helper layout mirrors the Windows install: host.py, release.txt and bin/ (yt-dlp, qjs) side by side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { talk as talk_ } from '../tools/native-client.mjs';

const HOST = fileURLToPath(new URL('../native/host.py', import.meta.url));
const PYTHON = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';

// Records every call as a JSON line in $HOME/calls.jsonl and pretends to download a video.
const FAKE_YTDLP = `#!${PYTHON}
import json, os, sys
args = sys.argv[1:]
with open(os.path.join(os.environ["HOME"], "calls.jsonl"), "a") as f:
    f.write(json.dumps(args) + "\\n")
if args == ["--version"]:
    print("2099.01.01")
elif args == ["-U"]:
    pass
else:
    out = args[args.index("-P") + 1]
    os.makedirs(out, exist_ok=True)
    target = os.path.join(out, "Fake video [abc].mp4")
    print("VDLT Fake video", flush=True)
    print("VDLP " + json.dumps({"status": "downloading", "downloaded_bytes": 5, "total_bytes": 10, "filename": target}), flush=True)
    with open(target, "wb") as f:
        f.write(b"0123456789")
    print("VDLP " + json.dumps({"status": "finished", "filename": target}), flush=True)
    print("VDLF " + target, flush=True)
`;

function makeHelper({ release, qjs = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-host-'));
  const dir = path.join(root, 'helper');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(home);
  fs.copyFileSync(HOST, path.join(dir, 'host.py'));
  fs.writeFileSync(path.join(dir, 'bin', 'yt-dlp'), FAKE_YTDLP, { mode: 0o755 });
  if (qjs) fs.writeFileSync(path.join(dir, 'bin', 'qjs'), '#!/bin/sh\n', { mode: 0o755 });
  if (release) fs.writeFileSync(path.join(dir, 'release.txt'), `${release}\n`);
  return { root, dir, home };
}

const calls = (home) =>
  fs.existsSync(path.join(home, 'calls.jsonl'))
    ? fs.readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

// Starts host.py like a browser does (minimal env).
const talk = ({ dir, home }, messages, until) =>
  talk_(PYTHON, [path.join(dir, 'host.py')], { env: { HOME: home, PATH: '/usr/bin:/bin' } }, messages, until);

// The detached `yt-dlp -U` may finish after the host exits; wait briefly for it to be recorded.
async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test('pong reports the bundled release and the bundled yt-dlp', async () => {
  const helper = makeHelper({ release: '1.3.0' });
  const [pong] = await talk(helper, [{ type: 'ping' }], (m) => m.type === 'pong');
  assert.equal(pong.release, '1.3.0');
  assert.equal(pong.ytdlp, path.join(helper.dir, 'bin', 'yt-dlp'));
  assert.equal(pong.ytdlpVersion, '2099.01.01');
});

test('pong has no release without release.txt (Homebrew/family install)', async () => {
  const helper = makeHelper();
  const [pong] = await talk(helper, [{ type: 'ping' }], (m) => m.type === 'pong');
  assert.equal(pong.release, undefined);
});

test('download saves into ~/Downloads and reports done', async () => {
  const helper = makeHelper({ release: '1.3.0' });
  const replies = await talk(helper, [{ type: 'download', url: 'https://www.youtube.com/watch?v=abc', quality: '720' }],
    (m) => m.type === 'done' || m.type === 'error');
  const done = replies.at(-1);
  assert.equal(done.type, 'done', JSON.stringify(replies));
  assert.equal(done.path, path.join(helper.home, 'Downloads', 'Fake video [abc].mp4'));
  assert.equal(done.bytes, 10);
  const run = calls(helper.home).find((a) => a.includes('--'));
  assert.ok(run.includes('res:720,vcodec:h264,acodec:m4a'));
});

test('a bundled QuickJS is passed to yt-dlp as its JS runtime', async () => {
  const helper = makeHelper({ release: '1.3.0', qjs: true });
  await talk(helper, [{ type: 'download', url: 'https://www.youtube.com/watch?v=abc', quality: 'best' }],
    (m) => m.type === 'done' || m.type === 'error');
  const run = calls(helper.home).find((a) => a.includes('--'));
  const i = run.indexOf('--js-runtimes');
  assert.notEqual(i, -1, JSON.stringify(run));
  assert.equal(run[i + 1], `quickjs:${path.join(helper.dir, 'bin', 'qjs')}`);
});

test('a bundled yt-dlp updates itself at most once a day', async () => {
  const helper = makeHelper({ release: '1.3.0' });
  const updates = () => calls(helper.home).filter((a) => a[0] === '-U').length;
  await talk(helper, [{ type: 'ping' }], (m) => m.type === 'pong');
  assert.ok(await waitFor(() => updates() === 1), 'first ping starts yt-dlp -U');
  await talk(helper, [{ type: 'ping' }], (m) => m.type === 'pong');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(updates(), 1, 'second ping within a day does not update again');

  const stamp = path.join(helper.dir, 'ytdlp-update.stamp');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(stamp, old, old);
  await talk(helper, [{ type: 'ping' }], (m) => m.type === 'pong');
  assert.ok(await waitFor(() => updates() === 2), 'a day later it updates again');
});
