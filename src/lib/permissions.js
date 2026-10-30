// Site access ("<all_urls>"): Firefox may install the extension without it, and the extension can't
// see videos until the user grants it. Shared by the popup and the welcome page.

const SITE_ACCESS = { origins: ['<all_urls>'] };

export function hasSiteAccess() {
  return chrome.permissions.contains(SITE_ACCESS);
}

// Must be called from a click handler (browsers require a user gesture).
export function requestSiteAccess() {
  return chrome.permissions.request(SITE_ACCESS);
}
