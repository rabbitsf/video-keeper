// Welcome page, opened once after install (background.js onInstalled): site access and getting started.

// #if youtube
// The YouTube helper section: wording comes from lib/helper.js so it matches the popup.
import { describeHelper, currentBrowser } from './lib/helper.js';
// #endif
import { hasSiteAccess, requestSiteAccess } from './lib/permissions.js';

const access = document.getElementById('access');

async function showSiteAccess() {
  access.hidden = await hasSiteAccess();
}

document.getElementById('access-button').addEventListener('click', async () => {
  if (await requestSiteAccess()) access.hidden = true;
});
showSiteAccess();

// #if youtube
const statusBox = document.getElementById('helper-status');
const install = document.getElementById('helper-install');
const recheck = document.getElementById('helper-recheck');
const hint = document.getElementById('helper-hint');
let installUrl;

async function showHelper() {
  statusBox.textContent = 'Checking for Video Keeper Helper…';
  statusBox.className = 'status';
  const [helper, platform] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'helperStatus' }),
    chrome.runtime.getPlatformInfo(),
  ]);
  const state = describeHelper(helper, platform.os, currentBrowser());
  installUrl = state.url;
  statusBox.textContent = state.ready ? `✓ ${state.text}. YouTube downloads are ready.` : state.text;
  statusBox.className = state.ready ? 'status ok' : 'status';
  install.hidden = !state.install;
  hint.hidden = !state.install;
  recheck.hidden = state.ready || !state.supported;
}

install.addEventListener('click', () => chrome.tabs.create({ url: installUrl }));
recheck.addEventListener('click', showHelper);
showHelper();
// #endif
