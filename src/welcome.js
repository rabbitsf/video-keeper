// Welcome page, opened once after install (background.js onInstalled): site access and the YouTube
// helper. Helper wording comes from lib/helper.js so it matches the popup.

import { describeHelper, HELPER_DOWNLOAD_URL } from './lib/helper.js';
import { hasSiteAccess, requestSiteAccess } from './lib/permissions.js';

const access = document.getElementById('access');
const statusBox = document.getElementById('helper-status');
const install = document.getElementById('helper-install');
const recheck = document.getElementById('helper-recheck');
const hint = document.getElementById('helper-hint');

async function showSiteAccess() {
  access.hidden = await hasSiteAccess();
}

async function showHelper() {
  statusBox.textContent = 'Checking for Video Keeper Helper…';
  statusBox.className = 'status';
  const [helper, platform] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'helperStatus' }),
    chrome.runtime.getPlatformInfo(),
  ]);
  const state = describeHelper(helper, platform.os);
  statusBox.textContent = state.ready ? `✓ ${state.text}. YouTube downloads are ready.` : state.text;
  statusBox.className = state.ready ? 'status ok' : 'status';
  install.hidden = !state.install;
  hint.hidden = !state.install;
  recheck.hidden = state.ready || platform.os !== 'mac';
}

document.getElementById('access-button').addEventListener('click', async () => {
  if (await requestSiteAccess()) access.hidden = true;
});
install.addEventListener('click', () => chrome.tabs.create({ url: HELPER_DOWNLOAD_URL }));
recheck.addEventListener('click', showHelper);

showSiteAccess();
showHelper();
