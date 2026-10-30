// Content script: scans the page for <video>/<source> elements and links to video files,
// and reports raw candidates to the background worker, which decides what counts.
// Guarded so the popup can safely re-inject it into tabs opened before install.
//
// When the extension is reloaded or updated, copies already running in open pages lose their
// connection ("Extension context invalidated"). Such a copy switches itself off, and a newly
// injected copy takes over from it instead of deferring to it.

(() => {
  const existing = window.__videoKeeper;
  if (existing?.alive()) {
    existing.scan();
    return;
  }
  existing?.stop(); // Left behind by a previous (reloaded or updated) version of the extension.

  let lastReport = '';
  let timer = null;

  // sendMessage throws synchronously (not a rejected promise) once the context is invalidated.
  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function collect() {
    const found = [];
    for (const video of document.querySelectorAll('video')) {
      const urls = new Set([video.currentSrc, video.src]);
      for (const source of video.querySelectorAll('source')) urls.add(source.src);
      for (const url of urls) {
        if (url) found.push({ url, from: 'element', width: video.videoWidth, height: video.videoHeight });
      }
    }
    for (const link of document.querySelectorAll('a[href]')) {
      found.push({ url: link.href, from: 'link' });
    }
    return found;
  }

  function scan() {
    if (!alive()) {
      stop();
      return;
    }
    const videos = collect();
    const report = JSON.stringify(videos);
    if (report === lastReport) return;
    lastReport = report;
    try {
      chrome.runtime.sendMessage({ type: 'pageVideos', pageTitle: document.title, videos }).catch(() => {});
    } catch {
      stop();
    }
  }

  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 500);
  }

  const observer = new MutationObserver(scheduleScan);

  function stop() {
    observer.disconnect();
    document.removeEventListener('loadedmetadata', scheduleScan, true);
    clearTimeout(timer);
  }

  window.__videoKeeper = { alive, scan, stop };
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href'],
  });
  // Media events don't bubble; capture them to pick up resolution and late-set sources.
  document.addEventListener('loadedmetadata', scheduleScan, true);
  scan();
})();
