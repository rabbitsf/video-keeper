// Chrome offscreen document: hosts HLS jobs because the service worker can't create blob: URLs.
// The job logic itself lives in lib/hls-job.js; this file only relays messages.
// The background worker owns job state and the actual chrome.downloads call.

import { runHlsJob, cancelHlsJob } from './lib/hls-job.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'startHls') {
    runHlsJob(msg.job, {
      report: (patch) => chrome.runtime.sendMessage({ type: 'jobUpdate', jobId: msg.job.id, patch }).catch(() => {}),
      deliver: (blob, filename) =>
        chrome.runtime
          .sendMessage({ type: 'hlsReady', jobId: msg.job.id, blobUrl: URL.createObjectURL(blob), filename })
          .catch(() => {}),
    });
  } else if (msg.type === 'cancel') {
    cancelHlsJob(msg.jobId);
  } else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.blobUrl);
  }
  sendResponse({ ok: true }); // Lets the background know the message wasn't lost during startup.
});
