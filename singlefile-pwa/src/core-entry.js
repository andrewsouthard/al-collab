// Entry point for the single-file-core browser bundle
// single-file-core copied to src/ for resolution

import { init, getPageData } from './single-file-core/single-file.js';

// Provide a fetch function that routes through the SW proxy
const makeProxiedFetch = (targetUrl) => async (url, fetchOptions = {}) => {
  try {
    const urlObj = new URL(url, targetUrl);
    if (urlObj.origin !== self.location.origin) {
      const proxyUrl = `/fetch-proxy?url=${encodeURIComponent(urlObj.href)}`;
      return fetch(proxyUrl, fetchOptions);
    }
    return fetch(url, fetchOptions);
  } catch {
    return fetch(url, fetchOptions);
  }
};

async function savePage(targetUrl, options = {}) {
  const proxiedFetch = makeProxiedFetch(targetUrl);
  init({ fetch: proxiedFetch, frameFetch: proxiedFetch });

  const defaultOptions = {
    url: targetUrl,
    removeHiddenElements: true,
    removeUnusedStyles: true,
    removeUnusedFonts: true,
    removeFrames: false,
    blockScripts: true,
    blockVideos: false,
    loadDeferredImages: true,
    loadDeferredImagesMaxIdleTime: 3000,
    compressContent: false,
    maxResourceSizeEnabled: true,
    maxResourceSize: 10,
    displayStats: false,
    insertCanonicalLink: false,
    insertMetaNoIndex: false,
    insertMetaCSP: false,
    saveRawPage: false,
    ...options,
  };

  try {
    const pageData = await getPageData(defaultOptions, {}, document, window);
    return pageData;
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

self.addEventListener('message', async (event) => {
  if (event.data && event.data.type === 'singlefile-save') {
    const result = await savePage(event.data.url, event.data.options || {});
    event.source.postMessage(
      { type: 'singlefile-result', data: result },
      { targetOrigin: event.origin }
    );
  }
});

self.SingleFileCore = { savePage };