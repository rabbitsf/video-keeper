import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  HELPER_REPO, HELPER_DOWNLOAD_URL, WINDOWS_HELPER_URL, compareVersions, helperProblem, describeHelper, MIN_HELPER_RELEASE,
} from '../src/lib/helper.js';

test('helper download repo matches tools/release.conf', () => {
  const conf = fs.readFileSync(new URL('../tools/release.conf', import.meta.url), 'utf8');
  assert.equal(HELPER_REPO, /^GITHUB_REPO="([^"]+)"/m.exec(conf)[1]);
});

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.1.0', MIN_HELPER_RELEASE), 0);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
});

test('helperProblem classifies Chrome and Firefox errors', () => {
  assert.equal(helperProblem('Specified native messaging host not found.'), 'missing');
  assert.equal(helperProblem('No such native application com.videodownloader.ytdlp'), 'missing');
  assert.equal(helperProblem('Access to the specified native messaging host is forbidden.'), 'misconfigured');
  assert.equal(helperProblem('Native host has exited.'), 'error');
});

test('describeHelper gives users a next step, never developer jargon', () => {
  assert.deepEqual(describeHelper({ ok: true, release: '1.2.0' }, 'mac'), { ready: true, install: false, supported: true, text: 'Ready — Video Keeper Helper 1.2.0' });
  const missing = describeHelper({ ok: false, reason: 'missing' }, 'mac');
  assert.equal(missing.install, true);
  assert.match(missing.text, /install the free Video Keeper Helper for Mac/);
  assert.match(describeHelper({ ok: false, reason: 'outdated', release: '1.0.0' }, 'mac').text, /1\.0\.0 is out of date/);
  assert.equal(missing.url, HELPER_DOWNLOAD_URL);
  for (const reason of ['missing', 'outdated', 'misconfigured', 'error']) {
    assert.doesNotMatch(describeHelper({ ok: false, reason }, 'mac').text, /native|install\.sh|yt-dlp helper/i);
  }
});

test('Firefox on Windows offers the Windows installer', () => {
  const missing = describeHelper({ ok: false, reason: 'missing' }, 'win', 'firefox');
  assert.equal(missing.install, true);
  assert.equal(missing.supported, true);
  assert.equal(missing.url, WINDOWS_HELPER_URL);
  assert.match(missing.text, /Video Keeper Helper for Windows/);
  assert.match(missing.text, /restart Firefox/);
  assert.equal(describeHelper({ ok: false, reason: 'outdated', release: '1.0.0' }, 'win', 'firefox').url, WINDOWS_HELPER_URL);
  assert.equal(describeHelper({ ok: true, release: '1.3.0' }, 'win', 'firefox').ready, true);
});

test('Chrome on Windows and other systems explain where YouTube downloads work', () => {
  const chrome = describeHelper({ ok: false, reason: 'missing' }, 'win', 'chrome');
  assert.equal(chrome.install, false);
  assert.equal(chrome.supported, false);
  assert.match(chrome.text, /Firefox/);
  const linux = describeHelper({ ok: false, reason: 'missing' }, 'linux', 'firefox');
  assert.equal(linux.install, false);
  assert.match(linux.text, /Mac and Windows/);
  assert.equal(describeHelper({ ok: false, reason: 'missing' }, 'mac', 'chrome').supported, true);
});

test('Windows installer link matches the installer the build produces', () => {
  const iss = fs.readFileSync(new URL('../tools/windows/installer.iss', import.meta.url), 'utf8');
  const name = /^OutputBaseFilename=(.+)$/m.exec(iss)[1].trim();
  assert.equal(WINDOWS_HELPER_URL, `https://github.com/${HELPER_REPO}/releases/latest/download/${name}.exe`);
});
