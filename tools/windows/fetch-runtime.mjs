#!/usr/bin/env node
// Fetch the runtime the Windows Video Keeper Helper ships with, into dist/windows-runtime/
// (every file checksum-verified; runs on macOS or on a Windows build machine):
//   python/        standalone CPython for Windows x64 (python-build-standalone) — runs native/host.py.
//                  Version pins are shared with tools/fetch-runtime.sh (read from it, not repeated).
//   bin/yt-dlp.exe official build — the starting copy; it updates itself (host.py, daily)
//   bin/ffmpeg.exe, bin/ffprobe.exe + their DLLs  LGPL shared build (BtbN FFmpeg-Builds; half the
//                  size of the static one) — merges video + audio
//   bin/qjs.exe    QuickJS-NG — the JavaScript engine yt-dlp needs for full YouTube support
//   licenses/, VERSIONS.txt
// x64 only: Windows on Arm runs it through its built-in emulation.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'dist', 'windows-runtime');

// Shared pins: the macOS runtime script is the single source of the Python and QuickJS versions.
const macScript = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-runtime.sh'), 'utf8');
const pin = (name) => {
  const match = macScript.match(new RegExp(`^${name}="([^"]+)"`, 'm'));
  if (!match) throw new Error(`${name} not found in tools/fetch-runtime.sh`);
  return match[1];
};
const PYTHON_VERSION = pin('PYTHON_VERSION');
const PYTHON_BUILD = pin('PYTHON_BUILD');
const QJS_VERSION = pin('QJS_VERSION');
// Windows-only pins. Must also match GitHub's asset digest (checked below).
const QJS_SHA256_WIN64 = '2aeabf0092c3262d6b2609824418f7dd7ed1f1df939f73b2b15645230cac0d77';
// BtbN keeps each month's LAST build for two years (dailies only 14 days) — pin month-end builds.
const FFMPEG_TAG = 'autobuild-2026-10-31-12-59';
const FFMPEG_ZIP = 'ffmpeg-n8.1.3-27-g8dca1586f4-win64-lgpl-shared-8.1.zip';
const FFMPEG_SHA256 = '5cef7bc48e513f3cee7c881e8b2999d835541edb1846c3e89443a67f8f8556ab';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fetchTo(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'video-keeper-build' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      return file;
    } catch (error) {
      if (attempt >= 3) throw new Error(`${url}: ${error.message}`);
    }
  }
}

const fetchText = async (url, file) => fs.readFileSync(await fetchTo(url, file), 'utf8');

function verify(file, expected, label) {
  const actual = sha256(file);
  if (!expected || actual !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch: ${label} (expected ${expected || 'none listed'}, got ${actual})`);
  }
}

// Digest GitHub records for a release asset (independent of the file we downloaded).
async function githubDigest(repo, tag, name) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: {
      'User-Agent': 'video-keeper-build',
      Accept: 'application/vnd.github+json',
      // CI runners share IPs and hit the anonymous rate limit; Actions provides a token.
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${repo} ${tag}: HTTP ${response.status}`);
  const asset = (await response.json()).assets.find((a) => a.name === name);
  if (!asset?.digest) throw new Error(`No digest for ${name} in ${repo} ${tag}`);
  return asset.digest.replace(/^sha256:/, '');
}

// Unpacks .zip and .tar.gz. bsdtar does both; on Windows use the system one (Git Bash's GNU tar can't unzip).
function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', dir], { stdio: 'inherit' });
}

function isWindowsExe(file) {
  const bytes = fs.readFileSync(file);
  return bytes.length > 0x40 && bytes.toString('latin1', 0, 2) === 'MZ' &&
    bytes.toString('latin1', bytes.readUInt32LE(0x3c), bytes.readUInt32LE(0x3c) + 4) === 'PE\0\0';
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-winrt-'));
try {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'licenses'));

  // --- Python -------------------------------------------------------------------------------------
  const pbs = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}`;
  const pyName = `cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
  const sums = await fetchText(`${pbs}/SHA256SUMS`, path.join(work, 'PYSUMS'));
  const pyExpected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === pyName)?.[0];
  verify(await fetchTo(`${pbs}/${encodeURIComponent(pyName)}`, path.join(work, 'python.tar.gz')), pyExpected, pyName);
  extract(path.join(work, 'python.tar.gz'), OUT); // → OUT/python
  // Trim what host.py never uses (GUI toolkit, test suite, headers, pip, venv launchers).
  for (const rel of ['Lib/test', 'Lib/idlelib', 'Lib/tkinter', 'Lib/turtledemo', 'Lib/ensurepip', 'Lib/lib2to3',
    'Lib/site-packages', 'Lib/venv', 'tcl', 'include', 'Scripts', 'libs', 'DLLs/_tkinter.pyd', 'DLLs/tcl86t.dll', 'DLLs/tk86t.dll']) {
    fs.rmSync(path.join(OUT, 'python', rel), { recursive: true, force: true });
  }
  for (const dir of fs.readdirSync(path.join(OUT, 'python'), { recursive: true })) {
    if (path.basename(dir) === '__pycache__') fs.rmSync(path.join(OUT, 'python', dir), { recursive: true, force: true });
  }
  if (!isWindowsExe(path.join(OUT, 'python', 'python.exe'))) throw new Error('python.exe missing or not a Windows program');
  fs.copyFileSync(path.join(OUT, 'python', 'LICENSE.txt'), path.join(OUT, 'licenses', 'Python-LICENSE.txt'));

  // --- yt-dlp (starting copy) -----------------------------------------------------------------------
  const yt = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const ytSums = await fetchText(`${yt}/SHA2-256SUMS`, path.join(work, 'YTSUMS'));
  const ytExpected = ytSums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === 'yt-dlp.exe')?.[0];
  verify(await fetchTo(`${yt}/yt-dlp.exe`, path.join(OUT, 'bin', 'yt-dlp.exe')), ytExpected, 'yt-dlp.exe');
  const ytRelease = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest', { redirect: 'manual' });
  const ytVersion = (ytRelease.headers.get('location') || '').split('/').pop() || 'unknown';
  await fetchTo(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${ytVersion}/LICENSE`, path.join(OUT, 'licenses', 'yt-dlp-LICENSE.txt'));

  // --- ffmpeg (LGPL) --------------------------------------------------------------------------------
  const ffZip = path.join(work, FFMPEG_ZIP);
  await fetchTo(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/${FFMPEG_ZIP}`, ffZip);
  verify(ffZip, FFMPEG_SHA256, FFMPEG_ZIP);
  extract(ffZip, path.join(work, 'ffmpeg'));
  const ffDir = path.join(work, 'ffmpeg', FFMPEG_ZIP.replace(/\.zip$/, ''));
  for (const file of fs.readdirSync(path.join(ffDir, 'bin'))) {
    if (file === 'ffmpeg.exe' || file === 'ffprobe.exe' || file.endsWith('.dll')) {
      fs.copyFileSync(path.join(ffDir, 'bin', file), path.join(OUT, 'bin', file));
    }
  }
  fs.copyFileSync(path.join(ffDir, 'LICENSE.txt'), path.join(OUT, 'licenses', 'FFmpeg-LICENSE.txt'));

  // --- QuickJS-NG -----------------------------------------------------------------------------------
  const qjsName = 'qjs-windows-x86_64.exe';
  const qjs = path.join(OUT, 'bin', 'qjs.exe');
  await fetchTo(`https://github.com/quickjs-ng/quickjs/releases/download/${QJS_VERSION}/${qjsName}`, qjs);
  verify(qjs, await githubDigest('quickjs-ng/quickjs', QJS_VERSION, qjsName), `${qjsName} (GitHub digest)`);
  verify(qjs, QJS_SHA256_WIN64, `${qjsName} (pinned)`);
  await fetchTo(`https://raw.githubusercontent.com/quickjs-ng/quickjs/${QJS_VERSION}/LICENSE`, path.join(OUT, 'licenses', 'QuickJS-NG-LICENSE.txt'));

  for (const file of fs.readdirSync(path.join(OUT, 'bin'))) {
    if (!isWindowsExe(path.join(OUT, 'bin', file))) throw new Error(`${file} is not a Windows program`);
  }
  fs.writeFileSync(path.join(OUT, 'VERSIONS.txt'), [
    `python ${PYTHON_VERSION} (python-build-standalone ${PYTHON_BUILD}, x86_64-pc-windows-msvc)`,
    `yt-dlp ${ytVersion} (starting copy; updates itself)`,
    `ffmpeg ${FFMPEG_ZIP} (BtbN ${FFMPEG_TAG}, LGPL)`,
    `quickjs-ng ${QJS_VERSION}`,
    '',
  ].join('\n'));
  console.log(fs.readFileSync(path.join(OUT, 'VERSIONS.txt'), 'utf8'));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
