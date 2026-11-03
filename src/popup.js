// Popup: renders the active tab's videos and download jobs from chrome.storage.session and
// asks the background worker to download/cancel. Holds no detection or download logic of its own.

import {
  filenameFor,
  formatBytes,
  formatResolution,
  formatDuration,
  extensionOf,
  // #if youtube
  isYtDlpPage,
  // #endif
} from './lib/media.js';
// #if youtube
import { describeHelper, HELPER_DOWNLOAD_URL } from './lib/helper.js';
// #endif
import { hasSiteAccess, requestSiteAccess } from './lib/permissions.js';

const list = document.getElementById('videos');
const empty = document.getElementById('empty');
const hint = document.querySelector('.hint');
// #if youtube
const ytdlpSection = document.getElementById('ytdlp');
const ytdlpQuality = document.getElementById('ytdlp-quality');
let ytdlpRow = null; // The YouTube section, kept across list re-renders.
// #endif
const downloadsSection = document.getElementById('downloads');
const jobList = document.getElementById('jobs');
const clearFinished = document.getElementById('clear-finished');
const status = new Map(); // url -> { text, cls } when starting a download fails
const selectedVariant = new Map(); // url -> variant url chosen in the quality picker
let rows = new Map(); // url -> { video, meta, button }
let jobs = {};

// ?tabId= shows the popup for a specific tab when the page is opened in a tab (used by E2E tests,
// since Firefox can't open the toolbar popup programmatically).
const forcedTabId = Number(new URLSearchParams(location.search).get('tabId'));
const tab = forcedTabId
  ? await chrome.tabs.get(forcedTabId)
  : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const ACTIVE = ['starting', 'downloading', 'processing', 'saving'];

function withTabContext(video) {
  return { ...video, tabId: tab.id, pageTitle: video.pageTitle || tab.title };
}

function unsupportedReason(video) {
  // #if youtube
  if (video.helperError) return video.helperError;
  // #endif
  if (video.live) return 'Live stream — not supported';
  if (video.encryption === 'drm') return 'DRM-protected — can’t download';
  return '';
}

function describe(video) {
  // #if youtube
  if (video.kind === 'ytdlp') {
    if (video.ytdlpVersion) return `Saves to Downloads via yt-dlp ${video.ytdlpVersion}`;
    return video.helperChecked ? 'Saves to Downloads (yt-dlp is set up on first download)' : 'Checking yt-dlp helper…';
  }
  // #endif
  if (video.kind === 'hls') {
    const variant = video.variants?.find((v) => v.url === selectedVariant.get(video.url)) || video;
    return [
      'HLS',
      formatResolution(variant.width, variant.height),
      formatDuration(video.duration),
      video.encryption === 'aes-128' ? 'AES-128' : '',
      video.separateAudio ? 'video only (separate audio track)' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  const type = (extensionOf(video.url) || video.contentType?.split('/')[1] || 'video').toUpperCase();
  return [type, formatResolution(video.width, video.height), formatBytes(video.size)]
    .filter(Boolean)
    .join(' · ');
}

function latestJobFor(url) {
  return Object.values(jobs)
    .filter((j) => j.videoUrl === url)
    .sort((a, b) => b.started - a.started)[0];
}

function jobText(job) {
  switch (job.status) {
    case 'starting':
      return { text: job.message || 'Starting…' };
    case 'downloading':
      if (job.kind === 'file') {
        const size = job.totalBytes ? ` of ${formatBytes(job.totalBytes)}` : '';
        return { text: `Downloading ${formatBytes(job.bytes) || '0 B'}${size}` };
      }
      // #if youtube
      if (job.kind === 'ytdlp') {
        const parts = [
          job.percent != null ? `${Math.floor(job.percent)}%` : '',
          job.speed ? `${formatBytes(job.speed)}/s` : '',
          job.eta ? `${formatDuration(job.eta)} left` : '',
          job.pass > 1 ? `part ${job.pass}` : '',
        ];
        return { text: `Downloading ${parts.filter(Boolean).join(' · ')}`.trim() };
      }
      // #endif
      return {
        text: `Downloading ${job.done}/${job.total || '?'} segments${job.bytes ? ` · ${formatBytes(job.bytes)}` : ''}`,
      };
    case 'processing':
      return { text: 'Merging video and audio…' };
    case 'saving':
      return { text: 'Saving file…' };
    case 'done':
      return { text: ['Saved', job.filename, formatBytes(job.bytes)].filter(Boolean).join(' · '), cls: 'ok' };
    case 'cancelled':
      return { text: 'Cancelled', cls: 'err' };
    default:
      return { text: `Failed: ${job.error || 'unknown error'}`, cls: 'err' };
  }
}

function render(videos) {
  list.replaceChildren();
  rows = new Map();
  let sectionShown = false; // A row shown outside the list, above it.
  // #if youtube
  if (ytdlpRow) rows.set(ytdlpRow.video.url, ytdlpRow);
  sectionShown = Boolean(ytdlpRow);
  // #endif
  const items = Object.values(videos).sort(
    (a, b) => (b.kind === 'hls') - (a.kind === 'hls') || (b.size || 0) - (a.size || 0),
  );
  empty.hidden = items.length > 0 || sectionShown;
  hint.hidden = items.length === 0 && sectionShown;
  for (const video of items) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = filenameFor(withTabContext(video));
    name.title = video.url;
    const meta = document.createElement('div');
    info.append(name, meta);

    if (video.variants?.length > 1) {
      const select = document.createElement('select');
      for (const v of video.variants) {
        const option = new Option(
          [formatResolution(v.width, v.height) || 'auto', v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : '']
            .filter(Boolean)
            .join(' · '),
          v.url,
        );
        select.append(option);
      }
      select.value = selectedVariant.get(video.url) || video.variants[0].url;
      select.addEventListener('change', () => {
        selectedVariant.set(video.url, select.value);
        applyStatus(video.url);
      });
      info.append(select);
    }

    const button = document.createElement('button');
    li.append(info, button);
    list.append(li);
    rows.set(video.url, { video, meta, button });
  }
  applyAll();
}

// Update one row's status line, progress bar and button from job/download state.
function applyStatus(url) {
  const row = rows.get(url);
  if (!row) return;
  const { video, meta, button } = row;
  const job = latestJobFor(url);
  const active = job && ACTIVE.includes(job.status);
  const blocked = unsupportedReason(video);
  let blockedCls = 'err';
  // #if youtube
  // A missing helper is a next step, not an error: show it in the normal colour.
  if (video.helperInstall || video.helperError) blockedCls = '';
  // #endif
  const s = job ? jobText(job) : status.get(url) || (blocked ? { text: blocked, cls: blockedCls } : null);
  meta.className = `meta ${s?.cls || ''}`;
  meta.textContent = s?.text || describe(video);

  button.textContent = active ? 'Cancel' : 'Download';
  button.className = active ? 'secondary' : '';
  button.disabled = Boolean(blocked);
  button.onclick = active ? () => chrome.runtime.sendMessage({ type: 'cancel', jobId: job.id }) : () => download(video);
  // #if youtube
  if (video.kind === 'ytdlp' && !active) button.textContent = 'Download with yt-dlp';
  if (video.helperInstall && !active) {
    button.textContent = 'Install helper';
    button.disabled = false;
    button.onclick = () => chrome.tabs.create({ url: HELPER_DOWNLOAD_URL });
  }
  // #endif
}

async function download(video) {
  status.delete(video.url);
  const options = { variantUrl: selectedVariant.get(video.url) };
  // #if youtube
  options.quality = ytdlpQuality.value;
  // #endif
  const result = await chrome.runtime.sendMessage({ type: 'download', video: withTabContext(video), options });
  if (result?.error) status.set(video.url, { text: `Failed: ${result.error}`, cls: 'err' });
  applyStatus(video.url);
}

// Progress for a job: segments (HLS), bytes (files) or percent; null = indeterminate.
function jobProgress(job) {
  if (job.kind === 'hls' && job.total) return { max: job.total, value: job.done };
  if (job.kind === 'file' && job.totalBytes) return { max: job.totalBytes, value: job.bytes };
  // #if youtube
  if (job.kind === 'ytdlp' && job.status === 'downloading' && job.percent != null) return { max: 100, value: job.percent };
  // #endif
  return null;
}

// Downloads list: every download from every tab, each with its own status and progress bar.
function renderJobs() {
  const all = Object.values(jobs).sort(
    (a, b) => ACTIVE.includes(b.status) - ACTIVE.includes(a.status) || b.started - a.started,
  );
  downloadsSection.hidden = all.length === 0;
  clearFinished.hidden = !all.some((j) => !ACTIVE.includes(j.status));
  jobList.replaceChildren(
    ...all.map((job) => {
      const active = ACTIVE.includes(job.status);
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = job.filename || 'Video';
      const s = jobText(job);
      const meta = document.createElement('div');
      meta.className = `meta ${s.cls || ''}`;
      meta.textContent = s.text;
      info.append(name, meta);
      if (active) {
        const bar = document.createElement('progress');
        const p = jobProgress(job);
        if (p) {
          bar.max = p.max;
          bar.value = p.value;
        }
        info.append(bar);
      }
      li.append(info);
      if (active) {
        const cancel = document.createElement('button');
        cancel.className = 'secondary';
        cancel.textContent = 'Cancel';
        cancel.onclick = () => chrome.runtime.sendMessage({ type: 'cancel', jobId: job.id });
        li.append(cancel);
      }
      return li;
    }),
  );
}

clearFinished.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'clearFinished' }));

async function refresh() {
  const stored = await chrome.storage.session.get(['tabs', 'jobs']);
  jobs = stored.jobs || {};
  renderJobs();
  render(stored.tabs?.[tab.id]?.videos || {});
}

function applyAll() {
  for (const url of rows.keys()) applyStatus(url);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.jobs) {
    jobs = changes.jobs.newValue || {};
    renderJobs();
  }
  // Firefox lists every key written, changed or not, so compare this tab's videos before
  // re-rendering (a re-render would also close an open quality picker mid-download).
  const videos = changes.tabs?.newValue?.[tab.id]?.videos || {};
  const tabChanged = changes.tabs && JSON.stringify(changes.tabs.oldValue?.[tab.id]?.videos || {}) !== JSON.stringify(videos);
  if (tabChanged) render(videos);
  else applyAll();
});

// Firefox may install the extension without its site access; ask for it (needs this click).
async function checkSiteAccess() {
  if (await hasSiteAccess()) return;
  const grant = document.getElementById('grant');
  grant.hidden = false;
  grant.querySelector('button').addEventListener('click', async () => {
    if (await requestSiteAccess()) location.reload();
  });
}

// #if youtube
// YouTube pages: hand the page URL to Video Keeper Helper (native/swift; native/host.py for family installs).
async function setupYtDlp() {
  if (!isYtDlpPage(tab.url)) return;
  ytdlpSection.hidden = false;
  const video = { kind: 'ytdlp', url: tab.url, pageTitle: tab.title };
  ytdlpRow = {
    video,
    meta: ytdlpSection.querySelector('.meta'),
    button: ytdlpSection.querySelector('button'),
  };
  rows.set(tab.url, ytdlpRow);
  applyStatus(tab.url);
  const [helper, platform] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'helperStatus' }),
    chrome.runtime.getPlatformInfo(),
  ]);
  const state = describeHelper(helper, platform.os);
  video.helperChecked = true;
  if (state.ready) {
    video.ytdlpVersion = helper.ytdlpVersion;
  } else {
    video.helperError = state.text;
    video.helperInstall = state.install;
    ytdlpQuality.hidden = true; // Nothing to choose until the helper works.
  }
  applyStatus(tab.url);
}
// #endif

// Ensure the content script is present (tabs opened before install don't have it) and rescan.
chrome.scripting
  .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/content.js'] })
  .catch(() => {}); // chrome:// pages and the Web Store can't be scripted.

checkSiteAccess();
// #if youtube
setupYtDlp();
// #endif
refresh();
