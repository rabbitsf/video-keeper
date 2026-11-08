#!/usr/bin/env node
// Smoke test of an INSTALLED Windows helper, run on Windows (CI or by hand):
//   1. HKCU registration points at a manifest Firefox would accept
//   2. the launcher answers ping with the expected release, yt-dlp version and ffmpeg
//   3. a real download through yt-dlp + ffmpeg lands in the Downloads folder
// Usage: smoke-test.mjs <expected release> [download URL]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { talk } from '../native-client.mjs';

const [expectedRelease, downloadUrl] = process.argv.slice(2);
if (!expectedRelease) throw new Error('usage: smoke-test.mjs <expected release> [download URL]');
const check = (ok, message) => {
  if (!ok) throw new Error(`FAILED: ${message}`);
  console.log(`ok - ${message}`);
};

// 1. Registration (reg.exe prints "    (Default)    REG_SZ    <path>").
const hostManifest = fs.readFileSync(new URL('../../native/host-manifest.py', import.meta.url), 'utf8');
const hostName = /^HOST_NAME = "([^"]+)"/m.exec(hostManifest)[1];
const regOut = execFileSync('reg', ['query', `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`, '/ve'], { encoding: 'utf8' });
const manifestPath = /REG_SZ\s+(.+)$/m.exec(regOut)?.[1].trim();
check(manifestPath && fs.existsSync(manifestPath), `registry points at an existing manifest (${manifestPath})`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
check(manifest.name === hostName && manifest.type === 'stdio', 'manifest name and type');
const launcher = path.resolve(path.dirname(manifestPath), manifest.path);
check(fs.existsSync(launcher), `launcher exists (${launcher})`);

// Firefox runs the .bat through cmd.exe; do the same. Firefox passes manifest path + extension ID.
const run = (messages, until, timeout) =>
  talk(`"${launcher}"`, [`"${manifestPath}"`, manifest.allowed_extensions[0]], { env: process.env, shell: true, timeout }, messages, until);

// 2. Ping.
const [pong] = await run([{ type: 'ping' }], (m) => m.type === 'pong', 60000);
console.log(JSON.stringify(pong));
check(pong.release === expectedRelease, `pong reports release ${expectedRelease}`);
check(/^\d{4}\.\d{2}\.\d{2}/.test(pong.ytdlpVersion), `yt-dlp runs (${pong.ytdlpVersion})`);
check(pong.ffmpeg === true, 'ffmpeg found');
check(pong.ytdlp.startsWith(path.dirname(manifestPath)), 'uses the bundled yt-dlp');

// 3. Download.
if (downloadUrl) {
  const replies = await run([{ type: 'download', url: downloadUrl, quality: 'best' }],
    (m) => ['done', 'error', 'cancelled'].includes(m.type), 300000);
  const last = replies.at(-1);
  console.log(JSON.stringify(last));
  check(last.type === 'done', 'download finished');
  check(fs.existsSync(last.path) && fs.statSync(last.path).size > 0, `file saved (${last.path})`);
  check(path.basename(path.dirname(last.path)).toLowerCase() === 'downloads', 'saved in the Downloads folder');
  fs.rmSync(last.path);
}
console.log('smoke test passed');
