// Video Keeper Helper (the Mac companion app for YouTube downloads): where to get it and what to tell
// the user about its state. Single source for the popup and the welcome page.
// HELPER_REPO must match GITHUB_REPO in tools/release.conf (enforced by test/helper.test.js).

export const HELPER_REPO = 'rabbitsf/video-keeper';
export const HELPER_DOWNLOAD_URL = `https://github.com/${HELPER_REPO}/releases/latest`;
// Oldest helper release this extension works with. Newer helpers update themselves, so this only
// matters for a helper that has been offline for a long time.
export const MIN_HELPER_RELEASE = '1.1.0';

export function compareVersions(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  return 0;
}

// Classify a native-messaging failure (Chrome: runtime.lastError, Firefox: port.error).
export function helperProblem(message = '') {
  if (/not found|no such native application/i.test(message)) return 'missing';
  if (/forbidden|permission|not allowed/i.test(message)) return 'misconfigured';
  return 'error';
}

// status: the background's helperStatus result; os: chrome.runtime.getPlatformInfo().os.
// Returns { ready, text, install } — install: offer the "Install helper" download link.
export function describeHelper(status, os) {
  if (status?.ok) {
    return { ready: true, install: false, text: `Ready — Video Keeper Helper ${status.release || ''}`.trim() };
  }
  if (os && os !== 'mac') {
    return { ready: false, install: false, text: 'YouTube downloads need Video Keeper Helper, which is available for Mac only.' };
  }
  switch (status?.reason) {
    case 'missing':
      return {
        ready: false,
        install: true,
        text: 'To download from YouTube, install the free Video Keeper Helper for Mac, then restart your browser.',
      };
    case 'outdated':
      return { ready: false, install: true, text: `Video Keeper Helper ${status.release} is out of date — please install the latest version.` };
    case 'misconfigured':
      return { ready: false, install: true, text: 'Video Keeper Helper needs to be reinstalled for this browser.' };
    default:
      return {
        ready: false,
        install: true,
        text: `Video Keeper Helper isn’t responding${status?.error ? ` (${status.error})` : ''}. Try reinstalling it.`,
      };
  }
}
