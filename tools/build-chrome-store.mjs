// Build the Chrome Web Store edition into dist/chrome-store (+ dist/chrome-store.zip to upload).
// Same sources as the unpacked Chrome extension, minus the YouTube feature, which the Web Store
// doesn't allow: "#if youtube" blocks are stripped (tools/strip-feature.mjs), the helper module is
// left out, and the manifest loses nativeMessaging and the "key" (the store assigns its own ID).
// The build fails if anything YouTube/helper-related is left or a script doesn't parse/resolve.
// Run: npm run build:chrome-store

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripFeature } from './strip-feature.mjs';

const FEATURE = 'youtube';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'chrome-store');
const zipPath = path.join(root, 'dist', 'chrome-store.zip');

// Not shipped: the helper module (YouTube only) and Firefox's background page.
const EXCLUDE = new Set(['src/lib/helper.js', 'src/background.html']);
const TEXT = new Set(['.js', '.html', '.css']);
// Must not appear anywhere in the output.
const FORBIDDEN = /youtube|youtu\.be|yt-?dlp|nativeMessaging|connectNative|native messaging|Keeper Helper|lib\/helper\.js|#if |#endif/i;

function storeManifest(chrome) {
  const { key, ...rest } = chrome;
  return { ...rest, permissions: chrome.permissions.filter((p) => p !== 'nativeMessaging') };
}

function copyDir(rel, files) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) {
      copyDir(child, files);
      continue;
    }
    if (EXCLUDE.has(child) || entry.name === '.DS_Store') continue;
    const target = path.join(out, child);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (TEXT.has(path.extname(child))) {
      const text = fs.readFileSync(path.join(root, child), 'utf8');
      try {
        fs.writeFileSync(target, stripFeature(text, FEATURE));
      } catch (err) {
        throw new Error(`${child}: ${err.message}`);
      }
    } else {
      fs.copyFileSync(path.join(root, child), target);
    }
    files.push(child);
  }
}

// Every check that the output is store-safe and still loads.
function verify(files) {
  const problems = [];
  for (const rel of [...files, 'manifest.json']) {
    if (!TEXT.has(path.extname(rel)) && rel !== 'manifest.json') continue;
    const text = fs.readFileSync(path.join(out, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (FORBIDDEN.test(line)) problems.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
    if (path.extname(rel) !== '.js') continue;
    // Relative imports must point at shipped files.
    for (const m of text.matchAll(/(?:import|from)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const dep = path.posix.join(path.posix.dirname(rel), m[1]);
      if (!files.includes(dep)) problems.push(`${rel}: imports missing ${dep}`);
    }
    // Parse via stdin as a module: `node --check <file>` reports success on broken files outside a package.
    try {
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: text, stdio: 'pipe' });
    } catch (err) {
      problems.push(`${rel}: does not parse\n${err.stderr}`);
    }
  }
  // HTML pages must only reference shipped files.
  for (const rel of files.filter((f) => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(out, rel), 'utf8');
    for (const m of text.matchAll(/(?:src|href)="([^":#]+)"/g)) {
      const dep = path.posix.join(path.posix.dirname(rel), m[1]);
      if (!files.includes(dep)) problems.push(`${rel}: references missing ${dep}`);
    }
  }
  if (problems.length) throw new Error(`Chrome Web Store build is not clean:\n  ${problems.join('\n  ')}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(out, { recursive: true });
const files = [];
copyDir('src', files);
copyDir('icons', files);
const manifest = storeManifest(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
verify(files);
execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: out });
const kb = Math.round(fs.statSync(zipPath).size / 1024);
console.log(`Built ${path.relative(root, out)} and ${path.relative(root, zipPath)} (v${manifest.version}, ${kb} KB)`);
