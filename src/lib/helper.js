// Video Keeper Helper (the companion app for YouTube downloads: Mac, and Windows for Firefox): where
// to get it and what to tell the user about its state. Single source for the popup and the welcome page.
// HELPER_REPO must match GITHUB_REPO in tools/release.conf (enforced by test/helper.test.js).

export const HELPER_REPO = 'rabbitsf/video-keeper';
export const HELPER_DOWNLOAD_URL = `https://github.com/${HELPER_REPO}/releases/latest`;
// The installer file tools/windows/installer.iss builds; it must be on the release marked "latest".
export const WINDOWS_HELPER_URL = `${HELPER_DOWNLOAD_URL}/download/Video-Keeper-Helper-Setup.exe`;
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

// Which helper this system can use: 'mac' (any browser), 'windows' (Firefox only — the Windows
// installer registers the helper for Firefox), or null.
function helperPlatform(os, browser) {
  if (os === 'mac') return 'mac';
  if (os === 'win' && browser === 'firefox') return 'windows';
  return null;
}

// Firefox extension pages run on moz-extension:// URLs.
export function currentBrowser() {
  return globalThis.location?.protocol === 'moz-extension:' ? 'firefox' : 'chrome';
}

// status: the background's helperStatus result; os: chrome.runtime.getPlatformInfo().os;
// browser: 'firefox' | 'chrome' (currentBrowser()).
// Returns { ready, text, install, url, supported } — install: offer the download link `url`;
// supported: this system can use the helper (offer "Check again").
export function describeHelper(status, os, browser) {
  const platform = helperPlatform(os, browser);
  if (status?.ok) {
    return { ready: true, install: false, supported: true, text: `Ready — Video Keeper Helper ${status.release || ''}`.trim() };
  }
  if (!platform) {
    const text = os === 'win'
      ? 'On Windows, YouTube downloads work in Firefox with the Video Keeper add-on.'
      : 'YouTube downloads need Video Keeper Helper, which is available for Mac and Windows (Firefox).';
    return { ready: false, install: false, supported: false, text };
  }
  const url = platform === 'windows' ? WINDOWS_HELPER_URL : HELPER_DOWNLOAD_URL;
  const offer = (text) => ({ ready: false, install: true, supported: true, url, text });
  switch (status?.reason) {
    case 'missing':
      return offer(platform === 'windows'
        ? 'To download from YouTube, install the free Video Keeper Helper for Windows, then restart Firefox.'
        : 'To download from YouTube, install the free Video Keeper Helper for Mac, then restart your browser.');
    case 'outdated':
      return offer(`Video Keeper Helper ${status.release} is out of date — please install the latest version.`);
    case 'misconfigured':
      return offer('Video Keeper Helper needs to be reinstalled for this browser.');
    default:
      return offer(`Video Keeper Helper isn’t responding${status?.error ? ` (${status.error})` : ''}. Try reinstalling it.`);
  }
}
