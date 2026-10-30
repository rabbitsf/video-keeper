// Canonical media helpers shared by the background worker and popup.
// Pure functions only — no chrome.* APIs — so they can be unit-tested in Node.

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'avi', 'flv'];

// Stream pieces and manifests: never offered as a standalone download.
const SEGMENT_EXTENSIONS = ['ts', 'm4s', 'm3u8', 'mpd', 'aac', 'vtt'];
const SEGMENT_CONTENT_TYPES = ['video/mp2t', 'video/iso.segment'];

// Anything smaller than this is almost certainly a preview, ad pixel, or fragment.
export const MIN_VIDEO_BYTES = 100 * 1024;

// Hosts that only serve separate video/audio pieces (unusable on their own); their pages use yt-dlp instead.
const PIECE_ONLY_HOSTS = /(^|\.)googlevideo\.com$/i;

// Pages handed to the local yt-dlp helper instead of in-browser detection.
const YTDLP_PAGE_PATTERNS = [
  /^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/(watch\?|shorts\/|live\/)/i,
  /^https?:\/\/youtu\.be\/[\w-]+/i,
];

export function isYtDlpPage(url) {
  return typeof url === 'string' && YTDLP_PAGE_PATTERNS.some((re) => re.test(url));
}

export function extensionOf(url) {
  try {
    const path = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(path);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

export function isDownloadableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Decide whether a network response (or a URL seen in the page) is a whole video file.
export function isVideoResource(url, contentType = '') {
  if (!isDownloadableUrl(url)) return false;
  if (PIECE_ONLY_HOSTS.test(new URL(url).hostname)) return false;
  const ext = extensionOf(url);
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (SEGMENT_EXTENSIONS.includes(ext) || SEGMENT_CONTENT_TYPES.includes(type)) return false;
  if (type.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.includes(ext);
}

// Total size from headers. Range responses (206) report the full size in Content-Range.
export function sizeFromHeaders(headers = []) {
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value;
  const range = get('content-range');
  if (range) {
    const total = /\/(\d+)\s*$/.exec(range);
    if (total) return Number(total[1]);
  }
  const length = get('content-length');
  return length && /^\d+$/.test(length) ? Number(length) : null;
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

const MIME_EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
};

export function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
}

// Filename for chrome.downloads: last URL segment, else page title, always with a video extension.
export function filenameFor(video) {
  let base = '';
  try {
    base = decodeURIComponent(new URL(video.url).pathname.split('/').pop() || '');
  } catch {
    base = '';
  }
  let ext = extensionOf(video.url);
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    ext = MIME_EXTENSIONS[(video.contentType || '').split(';')[0].trim()] || 'mp4';
    base = video.pageTitle || base.replace(/\.[^.]+$/, '') || 'video';
  } else {
    base = base.replace(/\.[^.]+$/, '');
  }
  return `${sanitizeFilename(base) || 'video'}.${ext}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const [h, m, sec] = hms.map((n) => String(n).padStart(2, '0'));
  return hms[0] ? `${hms[0]}:${m}:${sec}` : `${hms[1]}:${sec}`;
}

export function formatResolution(width, height) {
  if (!width || !height) return '';
  return `${Math.min(width, height)}p`;
}
