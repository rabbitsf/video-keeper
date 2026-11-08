// native/host.py, driven over the real native messaging protocol with a fake yt-dlp.
// Runs under macOS's /usr/bin/python3 (3.9) because host.py must stay compatible with it.
// The helper layout mirrors the Windows install: host.py, release.txt and bin/ (yt-dlp, qjs) side by side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
    # yt-dlp must not share the host's stdin (the browser's message pipe): on Windows a child that
    # inherits it hangs at startup while the host is blocked reading it. Reading here would block too.
    sys.stdin.read()
    out = args[args.index("-P") + 1]
    if "slow" in args[-1] and os.environ.get("FAKE_CHILD") != "1":
        # Like yt-dlp.exe (a launcher running the real yt-dlp as a child) or yt-dlp running ffmpeg:
        # the work happens in a child process, so stopping only this process would not stop it.
        import subprocess
        sys.exit(subprocess.call([sys.executable] + sys.argv, env=dict(os.environ, FAKE_CHILD="1")))
    if "slow" in args[-1]:  # keeps "downloading" until it is stopped
        os.makedirs(out, exist_ok=True)
        part = os.path.join(out, "Slow video [slow].mp4.part")
        print("VDLT Slow video", flush=True)
        import time
        for i in range(600):
            with open(part, "ab") as f:
                f.write(b"x" * 1000)
            print("VDLP " + json.dumps({"status": "downloading", "downloaded_bytes": i * 1000, "total_bytes": 10 ** 7,
                                        "filename": part[:-5], "tmpfilename": part}), flush=True)
            time.sleep(0.1)
        sys.exit(0)
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

test('cancel stops yt-dlp and removes its partial files', async () => {
  const helper = makeHelper({ release: '1.3.0' });
  const child = spawn(PYTHON, [path.join(helper.dir, 'host.py')], { env: { HOME: helper.home, PATH: '/usr/bin:/bin' } });
  const replies = [];
  let buffer = Buffer.alloc(0);
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([header, body]));
  };
  const finished = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString('utf8'));
        buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
        replies.push(message);
        if (message.type === 'progress' && message.bytes > 0 && !replies.cancelSent) {
          replies.cancelSent = true;
          send({ type: 'cancel' });
        }
        if (['done', 'error', 'cancelled'].includes(message.type)) resolve(message);
      }
    });
  });
  send({ type: 'download', url: 'https://example.com/slow', quality: 'best' });
  const result = await Promise.race([finished, new Promise((r) => setTimeout(() => r({ type: 'timeout' }), 15000))]);
  child.stdin.end();
  assert.equal(result.type, 'cancelled', JSON.stringify(replies.slice(-3)));
  const downloads = path.join(helper.home, 'Downloads');
  assert.deepEqual(fs.existsSync(downloads) ? fs.readdirSync(downloads) : [], []);
});

test('ping reuses the cached yt-dlp version until yt-dlp changes', async () => {
  const helper = makeHelper({ release: '1.3.0' });
  fs.writeFileSync(path.join(helper.dir, 'ytdlp-update.stamp'), ''); // no self-update during this test
  const versionCalls = () => calls(helper.home).filter((a) => a[0] === '--version').length;
  const ping = async () => (await talk(helper, [{ type: 'ping' }], (m) => m.type === 'pong'))[0];
  assert.equal((await ping()).ytdlpVersion, '2099.01.01');
  assert.equal((await ping()).ytdlpVersion, '2099.01.01');
  assert.equal(versionCalls(), 1, 'second ping uses the cache');
  const ytdlp = path.join(helper.dir, 'bin', 'yt-dlp');
  fs.appendFileSync(ytdlp, '# updated\n'); // yt-dlp replaced (e.g. by its self-update)
  assert.equal((await ping()).ytdlpVersion, '2099.01.01');
  assert.equal(versionCalls(), 2, 'a changed yt-dlp is asked again');
});
