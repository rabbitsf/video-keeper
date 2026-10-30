// Background script (Chrome: service worker; Firefox: background page): the single owner of
// per-tab video state, download jobs, and downloading.
// State lives in chrome.storage.session so it survives the worker being suspended;
// the popup reads it from there and re-renders on chrome.storage.onChanged.

import {
  isVideoResource,
  isDownloadableUrl,
  sizeFromHeaders,
  normalizeUrl,
  filenameFor,
  MIN_VIDEO_BYTES,
} from './lib/media.js';
import { isHlsResource, parsePlaylist, strongerEncryption } from './lib/hls.js';
import { runHlsJob, cancelHlsJob } from './lib/hls-job.js';
import { helperProblem, describeHelper, compareVersions, MIN_HELPER_RELEASE } from './lib/helper.js';

const MAX_VIDEOS_PER_TAB = 50;
const ACTIVE_JOB_STATES = ['starting', 'downloading', 'processing', 'saving'];
const NATIVE_HOST = 'com.videodownloader.ytdlp';

const state = { tabs: {}, jobs: {} };
const ready = chrome.storage.session.get(['tabs', 'jobs']).then((r) => {
  state.tabs = r.tabs || {};
  state.jobs = r.jobs || {};
});
let queue = Promise.resolve();

// Serialize every read-modify-write of state so concurrent events can't clobber each other.
function commit(mutate, badgeTabId = null) {
  queue = queue
    .then(async () => {
      await ready;
      if (mutate() === false) return;
      await chrome.storage.session.set({ tabs: state.tabs, jobs: state.jobs });
      if (badgeTabId != null) await updateBadge(badgeTabId);
    })
    .catch((err) => console.error('[video-downloader]', err));
  return queue;
}

function updateTab(tabId, mutate) {
  return commit(() => mutate(tabId), tabId);
}

function updateJob(jobId, patch) {
  return commit(() => {
    if (!state.jobs[jobId]) return false;
    Object.assign(state.jobs[jobId], patch);
  });
}

const inspectedPlaylists = new Map(); // tabId -> Set of playlist URLs already fetched (in-memory dedupe)

function resetTab(tabId) {
  delete state.tabs[tabId];
  inspectedPlaylists.delete(tabId);
  for (const [id, job] of Object.entries(state.jobs)) {
    if (job.tabId === tabId && !ACTIVE_JOB_STATES.includes(job.status)) delete state.jobs[id];
  }
}

// Canonical entry point for every detection source (network, page scan, HLS inspection).
function addVideo(tabId, video) {
  return updateTab(tabId, () => {
    if (video.size != null && video.size < MIN_VIDEO_BYTES) return false;
    const tab = (state.tabs[tabId] ||= { videos: {} });
    const key = normalizeUrl(video.url);
    if (video.kind === 'hls') {
      // A player loads the master playlist, then one of its variants: list only the master.
      const isKnownVariant = Object.values(tab.videos).some((v) =>
        v.variants?.some((variant) => normalizeUrl(variant.url) === key),
      );
      if (isKnownVariant) return false;
      for (const variant of video.variants || []) delete tab.videos[normalizeUrl(variant.url)];
    }
    const existing = tab.videos[key];
    if (!existing && Object.keys(tab.videos).length >= MAX_VIDEOS_PER_TAB) return false;
    const merged = { ...existing, url: key, firstSeen: existing?.firstSeen ?? Date.now() };
    for (const [k, v] of Object.entries(video)) {
      if (k !== 'url' && v != null && v !== '' && v !== 0) merged[k] = v;
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return false;
    tab.videos[key] = merged;
  });
}

async function updateBadge(tabId) {
  const count = Object.keys(state.tabs[tabId]?.videos || {}).length;
  try {
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
  } catch {
    // Tab already closed.
  }
}

// --- Detection: HLS playlists ------------------------------------------------------------

async function fetchPlaylist(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parsePlaylist(await response.text(), url);
}

async function inspectHls(tabId, url) {
  const key = normalizeUrl(url);
  let seen = inspectedPlaylists.get(tabId);
  if (!seen) inspectedPlaylists.set(tabId, (seen = new Set()));
  if (seen.has(key)) return;
  seen.add(key);
  try {
    const playlist = await fetchPlaylist(url);
    if (playlist.type === 'media') {
      if (!playlist.segments.length) return;
      await addVideo(tabId, {
        url,
        kind: 'hls',
        variants: [],
        duration: playlist.duration,
        live: playlist.live,
        encryption: playlist.encryption,
      });
      return;
    }
    if (!playlist.variants.length) return;
    // The best variant's media playlist tells us duration, liveness and encryption.
    const best = await fetchPlaylist(playlist.variants[0].url).catch(() => null);
    await addVideo(tabId, {
      url,
      kind: 'hls',
      variants: playlist.variants.map(({ url, width, height, bandwidth }) => ({ url, width, height, bandwidth })),
      width: playlist.variants[0].width,
      height: playlist.variants[0].height,
      separateAudio: playlist.separateAudio,
      duration: best?.duration,
      live: best?.live,
      encryption: strongerEncryption(playlist.encryption, best?.encryption),
    });
  } catch (err) {
    seen.delete(key);
    console.warn('[video-downloader] HLS inspect failed', url, err);
  }
}

// --- Detection: network traffic ---------------------------------------------------------

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const contentType =
      details.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
    if (details.type === 'main_frame') {
      // New page in this tab: forget the old page's videos (unless the page *is* a video).
      updateTab(details.tabId, resetTab);
    }
    if (isHlsResource(details.url, contentType)) {
      inspectHls(details.tabId, details.url);
      return;
    }
    if (!isVideoResource(details.url, contentType)) return;
    addVideo(details.tabId, {
      url: details.url,
      contentType: contentType.split(';')[0].trim(),
      size: sizeFromHeaders(details.responseHeaders),
      source: 'network',
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => updateTab(tabId, resetTab));

// First install: show the welcome page (what it does, pinning the button, the YouTube helper).
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
});

// --- Messages from content script, popup and offscreen document -------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'pageVideos':
      if (sender.tab) handlePageVideos(sender.tab.id, msg);
      return;
    case 'download':
      downloadVideo(msg.video, msg.options).then(sendResponse, (err) => sendResponse({ error: err.message }));
      return true;
    case 'cancel':
      cancelJob(msg.jobId);
      return;
    case 'helperStatus':
      checkHelper().then(sendResponse);
      return true;
    case 'jobUpdate':
      updateJob(msg.jobId, msg.patch).then(() => maybeCloseOffscreen());
      return;
    case 'hlsReady':
      saveHlsOutput(msg);
      return;
  }
});

function handlePageVideos(tabId, msg) {
  for (const item of msg.videos) {
    if (isHlsResource(item.url)) {
      inspectHls(tabId, item.url);
      continue;
    }
    // Elements are trusted to be video; plain links must look like video files.
    const ok = item.from === 'element' ? isDownloadableUrl(item.url) : isVideoResource(item.url);
    if (!ok) continue;
    addVideo(tabId, {
      url: item.url,
      width: item.width,
      height: item.height,
      pageTitle: msg.pageTitle,
      source: item.from,
    });
  }
}

// --- Downloading ---------------------------------------------------------------------------

// Canonical download implementation — every download trigger routes here.
async function downloadVideo(video, { variantUrl, quality } = {}) {
  if (video.kind === 'hls') return startHlsJob(video, variantUrl);
  if (video.kind === 'ytdlp') return startYtDlpJob(video, quality);
  const downloadId = await chrome.downloads.download({
    url: video.url,
    filename: filenameFor(video),
    conflictAction: 'uniquify',
  });
  return { downloadId };
}

async function startHlsJob(video, variantUrl) {
  if (video.live) throw new Error('Live streams are not supported');
  if (video.encryption === 'drm') throw new Error('DRM-protected stream');
  const id = crypto.randomUUID();
  const job = {
    id,
    kind: 'hls',
    tabId: video.tabId,
    videoUrl: video.url,
    playlistUrl: variantUrl || video.variants?.[0]?.url || video.url,
    filename: filenameFor({ ...video, contentType: 'video/mp4' }),
    status: 'starting',
    done: 0,
    total: 0,
    bytes: 0,
    started: Date.now(),
  };
  await commit(() => {
    state.jobs[id] = job;
  });
  if (!(await runHls(job))) {
    await updateJob(id, { status: 'error', error: 'Download worker did not start' });
  }
  return { jobId: id };
}

async function saveHlsOutput({ jobId, blobUrl, filename }) {
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' });
    await updateJob(jobId, { downloadId, filename, blobUrl });
  } catch (err) {
    await revokeHlsBlob(blobUrl);
    await updateJob(jobId, { status: 'error', error: err.message });
    maybeCloseOffscreen();
  }
}

chrome.downloads.onChanged.addListener(async ({ id, state: change }) => {
  if (!change || change.current === 'in_progress') return;
  await ready;
  const job = Object.values(state.jobs).find((j) => j.downloadId === id);
  if (!job) return;
  await revokeHlsBlob(job.blobUrl);
  const complete = change.current === 'complete';
  await updateJob(job.id, complete ? { status: 'done' } : { status: 'error', error: 'Saving the file failed' });
  if (complete) notifyDone(job.filename);
  maybeCloseOffscreen();
});

function cancelJob(jobId) {
  if (nativePorts.has(jobId)) nativePorts.get(jobId).postMessage({ type: 'cancel' });
  else cancelHls(jobId);
}

function notifyDone(filename) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Download complete',
    message: `${filename} saved to Downloads`,
  });
}

// --- yt-dlp helper (native messaging) ----------------------------------------------------
// One native port per job: the helper process lives exactly as long as the job, and an open
// port also keeps this service worker alive while yt-dlp runs.

const nativePorts = new Map(); // jobId -> Port

// Chrome reports native port errors via runtime.lastError, Firefox via port.error.
function portErrorMessage(port) {
  return port.error?.message || chrome.runtime.lastError?.message || '';
}

// Helper status for the popup/welcome page: { ok, release, ytdlpVersion } or { ok: false, reason, error }.
// lib/helper.js:describeHelper turns it into words for the user.
function helperFailure(message = '') {
  return { ok: false, reason: helperProblem(message), error: message };
}

function checkHelper() {
  return new Promise((resolve) => {
    let port;
    const finish = (result) => {
      clearTimeout(timer);
      port?.disconnect();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'error', error: 'no response' }), 5000);
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      finish(helperFailure(err.message));
      return;
    }
    port.onMessage.addListener((msg) => {
      if (msg.type !== 'pong') return;
      // host.py (family/Homebrew path) reports no release; the packaged helper does.
      if (msg.release && compareVersions(msg.release, MIN_HELPER_RELEASE) < 0) {
        finish({ ok: false, reason: 'outdated', release: msg.release });
      } else if (!msg.ytdlp) {
        finish({ ok: false, reason: 'error', error: 'yt-dlp missing' });
      } else {
        finish({ ok: true, ytdlpVersion: msg.ytdlpVersion, ffmpeg: msg.ffmpeg, release: msg.release });
      }
    });
    port.onDisconnect.addListener((p) => {
      port = null;
      finish(helperFailure(portErrorMessage(p)));
    });
    port.postMessage({ type: 'ping' });
  });
}

async function startYtDlpJob(video, quality = 'best') {
  const id = crypto.randomUUID();
  await commit(() => {
    state.jobs[id] = {
      id,
      kind: 'ytdlp',
      tabId: video.tabId,
      videoUrl: video.url,
      quality,
      filename: video.pageTitle || '',
      status: 'starting',
      started: Date.now(),
    };
  });
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePorts.set(id, port);
  port.onMessage.addListener((msg) => handleHelperMessage(id, port, msg));
  port.onDisconnect.addListener((p) => {
    nativePorts.delete(id);
    const error = describeHelper(helperFailure(portErrorMessage(p))).text;
    commit(() => {
      const job = state.jobs[id];
      if (!job || !ACTIVE_JOB_STATES.includes(job.status)) return false;
      Object.assign(job, { status: 'error', error });
    });
  });
  port.postMessage({ type: 'download', url: video.url, quality });
  return { jobId: id };
}

async function handleHelperMessage(jobId, port, msg) {
  if (msg.type === 'progress') {
    const { type, title, ...patch } = msg;
    await updateJob(jobId, title ? { ...patch, filename: title } : patch);
    return;
  }
  if (msg.type === 'done') {
    await updateJob(jobId, { status: 'done', filename: msg.filename, path: msg.path, bytes: msg.bytes });
    notifyDone(msg.filename);
  } else if (msg.type === 'cancelled') {
    await updateJob(jobId, { status: 'cancelled' });
  } else if (msg.type === 'error') {
    await updateJob(jobId, { status: 'error', error: msg.error });
  } else {
    return;
  }
  nativePorts.delete(jobId);
  port.disconnect();
}

// --- Where HLS jobs run -------------------------------------------------------------------
// Jobs need blob: URLs. Chrome's service worker can't create them, so jobs run in an offscreen
// document; Firefox's background page can, so jobs run right here. Both use lib/hls-job.js.

const HAS_OFFSCREEN = typeof chrome.offscreen !== 'undefined';

async function runHls(job) {
  if (HAS_OFFSCREEN) {
    await ensureOffscreen();
    return sendToOffscreen({ type: 'startHls', job });
  }
  runHlsJob(job, {
    report: (patch) => updateJob(job.id, patch),
    deliver: (blob, filename) => saveHlsOutput({ jobId: job.id, blobUrl: URL.createObjectURL(blob), filename }),
  });
  return true;
}

function cancelHls(jobId) {
  if (HAS_OFFSCREEN) sendToOffscreen({ type: 'cancel', jobId });
  else cancelHlsJob(jobId);
}

async function revokeHlsBlob(blobUrl) {
  if (HAS_OFFSCREEN) await sendToOffscreen({ type: 'revoke', blobUrl });
  else URL.revokeObjectURL(blobUrl);
}

// --- Offscreen document lifecycle (Chrome only) -------------------------------------------

const OFFSCREEN_URL = 'src/offscreen.html';
let offscreenReady = null; // Shared by all callers so concurrent jobs never race document creation.

function ensureOffscreen() {
  offscreenReady ||= (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Join HLS stream segments into a single downloadable file',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

// The offscreen document acknowledges every message; retry until its listener is up.
async function sendToOffscreen(msg) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const reply = await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => null);
    if (reply?.ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn('[video-downloader] offscreen document did not respond', msg.type);
  return false;
}

async function maybeCloseOffscreen() {
  if (!HAS_OFFSCREEN) return;
  await queue;
  if (Object.values(state.jobs).some((j) => j.kind === 'hls' && ACTIVE_JOB_STATES.includes(j.status))) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) return;
  offscreenReady = null;
  await chrome.offscreen.closeDocument().catch(() => {});
}
