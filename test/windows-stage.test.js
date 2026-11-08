// tools/windows/stage-helper.mjs assembles the folder the Windows installer ships (dist/windows-helper).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const conf = fs.readFileSync(path.join(ROOT, 'tools', 'release.conf'), 'utf8');
const hostManifest = fs.readFileSync(path.join(ROOT, 'native', 'host-manifest.py'), 'utf8');
const pyConst = (name) => new RegExp(`^${name} = "([^"]+)"`, 'm').exec(hostManifest)[1];

function stage() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-stage-'));
  const runtime = path.join(tmp, 'runtime');
  fs.mkdirSync(path.join(runtime, 'python'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'bin'));
  fs.mkdirSync(path.join(runtime, 'licenses'));
  fs.writeFileSync(path.join(runtime, 'python', 'python.exe'), 'fake');
  fs.writeFileSync(path.join(runtime, 'bin', 'yt-dlp.exe'), 'fake');
  fs.writeFileSync(path.join(runtime, 'licenses', 'yt-dlp-LICENSE.txt'), 'license');
  fs.writeFileSync(path.join(runtime, 'VERSIONS.txt'), 'versions');
  const out = path.join(tmp, 'out');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'windows', 'stage-helper.mjs'), '--runtime', runtime, '--out', out]);
  return out;
}

test('staged helper has host.py, the runtime and the release number from release.conf', () => {
  const out = stage();
  assert.equal(fs.readFileSync(path.join(out, 'host.py'), 'utf8'), fs.readFileSync(path.join(ROOT, 'native', 'host.py'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(out, 'release.txt'), 'utf8').trim(), /^WINDOWS_HELPER_RELEASE="([^"]+)"/m.exec(conf)[1]);
  for (const rel of ['python/python.exe', 'bin/yt-dlp.exe', 'licenses/yt-dlp-LICENSE.txt', 'VERSIONS.txt']) {
    assert.ok(fs.existsSync(path.join(out, rel)), rel);
  }
});

test('Firefox host manifest comes from native/host-manifest.py and points at the launcher', () => {
  const out = stage();
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'firefox-host.json'), 'utf8'));
  assert.equal(manifest.name, pyConst('HOST_NAME'));
  assert.deepEqual(manifest.allowed_extensions, [pyConst('FIREFOX_ID')]);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, 'video-keeper-helper.bat'); // relative to the manifest (Firefox on Windows)
});

test('launcher runs host.py with the bundled Python in isolated mode, CRLF line endings', () => {
  const out = stage();
  const bat = fs.readFileSync(path.join(out, 'video-keeper-helper.bat'), 'utf8');
  assert.match(bat, /"%~dp0python\\python\.exe" -I "%~dp0host\.py"/);
  assert.ok(bat.split('\n').slice(0, -1).every((line) => line.endsWith('\r')), 'CRLF');
});
