// Content script: scans the page for <video>/<source> elements and links to video files,
// and reports raw candidates to the background worker, which decides what counts.
// Guarded so the popup can safely re-inject it into tabs opened before install.

(() => {
  if (window.__videoDownloaderLoaded) {
    window.__videoDownloaderScan?.();
    return;
  }
  window.__videoDownloaderLoaded = true;

  let lastReport = '';
  let timer = null;

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
    const videos = collect();
    const report = JSON.stringify(videos);
    if (report === lastReport) return;
    lastReport = report;
    chrome.runtime.sendMessage({ type: 'pageVideos', pageTitle: document.title, videos }).catch(() => {});
  }

  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 500);
  }

  window.__videoDownloaderScan = scan;
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href'],
  });
  // Media events don't bubble; capture them to pick up resolution and late-set sources.
  document.addEventListener('loadedmetadata', scheduleScan, true);
  scan();
})();
