#!/usr/bin/env node
// Assemble the Windows Video Keeper Helper exactly as it is installed (dist/windows-helper/):
//   host.py                 native/host.py, unchanged (the protocol's single implementation)
//   release.txt             WINDOWS_HELPER_RELEASE from tools/release.conf (reported in pong)
//   video-keeper-helper.bat launcher Firefox starts: bundled Python, isolated mode
//   firefox-host.json       native messaging host manifest, written by native/host-manifest.py;
//                           the installer points HKCU\Software\Mozilla\NativeMessagingHosts\<host> at it
//   python/ bin/ licenses/ VERSIONS.txt   from tools/windows/fetch-runtime.mjs
// Runs on macOS or Windows; tools/windows/installer.iss packs the result (on Windows).
// Usage: stage-helper.mjs [--runtime DIR] [--out DIR]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : path.resolve(process.argv[i + 1]);
};
const RUNTIME = arg('--runtime', path.join(ROOT, 'dist', 'windows-runtime'));
const OUT = arg('--out', path.join(ROOT, 'dist', 'windows-helper'));
const LAUNCHER = 'video-keeper-helper.bat';

const conf = fs.readFileSync(path.join(ROOT, 'tools', 'release.conf'), 'utf8');
const release = /^WINDOWS_HELPER_RELEASE="([^"]+)"/m.exec(conf)?.[1];
if (!release) throw new Error('WINDOWS_HELPER_RELEASE missing in tools/release.conf');
for (const dir of ['python', 'bin', 'licenses']) {
  if (!fs.existsSync(path.join(RUNTIME, dir))) {
    throw new Error(`${path.join(RUNTIME, dir)} missing — run node tools/windows/fetch-runtime.mjs first`);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const entry of ['python', 'bin', 'licenses', 'VERSIONS.txt']) {
  fs.cpSync(path.join(RUNTIME, entry), path.join(OUT, entry), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'native', 'host.py'), path.join(OUT, 'host.py'));
fs.writeFileSync(path.join(OUT, 'release.txt'), `${release}\n`);
// Anything this prints would corrupt the native messaging stream, hence @echo off.
// -I: ignore PYTHON* environment variables and the user's site-packages.
fs.writeFileSync(path.join(OUT, LAUNCHER), [
  '@echo off',
  'rem Video Keeper Helper: Firefox starts this through firefox-host.json.',
  '"%~dp0python\\python.exe" -I "%~dp0host.py" %*',
  '',
].join('\r\n'));
// Firefox on Windows resolves a relative "path" against the manifest's own folder.
const python = process.platform === 'win32' ? 'python' : 'python3';
execFileSync(python, [path.join(ROOT, 'native', 'host-manifest.py'), 'firefox', LAUNCHER, path.join(OUT, 'firefox-host.json')]);
console.log(`Staged Windows helper ${release} in ${OUT}`);
