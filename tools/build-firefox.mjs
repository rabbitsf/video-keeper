// Build the Firefox add-on into dist/firefox from the same sources Chrome loads.
// The root manifest.json is canonical; the Firefox manifest is derived from it here.
// Run: npm run build:firefox

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match FIREFOX_ID in native/install.sh (the yt-dlp helper's allowed_extensions).
export const FIREFOX_ID = 'video-downloader-14a7930f@personal.addon';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'firefox');

// Chrome-only files: Firefox runs HLS jobs in its background page instead of an offscreen document.
const CHROME_ONLY = new Set(['src/offscreen.html', 'src/offscreen.js']);

function firefoxManifest(chrome) {
  const { key, background, ...rest } = chrome;
  return {
    ...rest,
    permissions: chrome.permissions.filter((p) => p !== 'offscreen'),
    background: { page: 'src/background.html' },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ID,
        strict_min_version: '142.0', // data_collection_permissions needs 142+
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}

function copyDir(rel) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) copyDir(child);
    else if (!CHROME_ONLY.has(child) && entry.name !== '.DS_Store') {
      fs.mkdirSync(path.join(out, rel), { recursive: true });
      fs.copyFileSync(path.join(root, child), path.join(out, child));
    }
  }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
copyDir('src');
copyDir('icons');
const manifest = firefoxManifest(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${path.relative(root, out)} (v${manifest.version}, ${FIREFOX_ID})`);
