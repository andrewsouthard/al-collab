// Main app logic for SingleFile PWA

(function () {
  'use strict';

  const DOM = {
    urlInput: document.getElementById('urlInput'),
    loadBtn: document.getElementById('loadBtn'),
    saveBtn: document.getElementById('saveBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    proxyFrame: document.getElementById('proxyFrame'),
    placeholder: document.getElementById('placeholder'),
    statusText: document.getElementById('statusText'),
    spinner: document.getElementById('spinner'),
    resultInfo: document.getElementById('resultInfo'),
  };

  let currentUrl = '';
  let savedResult = null;

  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      console.log('SW registered, scope:', reg.scope);
    }).catch((err) => {
      console.error('SW registration failed:', err);
      setStatus('⚠ Service Worker registration failed. The proxy won\'t work.', 'error');
    });
  } else {
    setStatus('⚠ Service Workers not supported in this browser.', 'error');
  }

  // ── Event listeners ──────────────────────────────────────────────

  DOM.loadBtn.addEventListener('click', loadPage);
  DOM.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadPage();
  });

  DOM.saveBtn.addEventListener('click', savePage);
  DOM.downloadBtn.addEventListener('click', downloadResult);

  // Listen for results from the iframe
  window.addEventListener('message', handleIframeMessage);

  // Listen for SW debug messages
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'sw-debug') {
      console.log(event.data.msg);
    }
  });

  // ── Load page in iframe ──────────────────────────────────────────
  // The iframe loads via the SW proxy (/proxy/URL), which keeps it
  // same-origin with the PWA. The SW fetches the target URL, injects
  // the core script, and returns the modified HTML.

  function loadPage() {
    let url = DOM.urlInput.value.trim();
    if (!url) return;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
      DOM.urlInput.value = url;
    }

    currentUrl = url;
    savedResult = null;
    DOM.saveBtn.disabled = true;
    DOM.downloadBtn.style.display = 'none';
    DOM.resultInfo.classList.remove('visible');
    DOM.resultInfo.innerHTML = '';

    setStatus(`Loading ${url}…`, 'loading');
    DOM.placeholder.style.display = 'none';

    // Load via SW proxy — keeps iframe same-origin
    const proxyUrl = `/proxy/${encodeURIComponent(url)}`;
    DOM.proxyFrame.src = 'about:blank';
    setTimeout(() => {
      DOM.proxyFrame.src = proxyUrl;
    }, 50);
  }

  // ── Save page via single-file-core in the iframe ──────────────────

  function savePage() {
    if (!currentUrl) return;

    DOM.saveBtn.disabled = true;
    setStatus('Processing page with SingleFile core…', 'loading');

    try {
      const iframeWin = DOM.proxyFrame.contentWindow;
      if (!iframeWin) {
        setStatus('Cannot access iframe content. Try reloading.', 'error');
        DOM.saveBtn.disabled = false;
        return;
      }

      // Send message to the iframe's core bundle
      // The core-bundle.js was injected by the SW and listens for this.
      // The iframe is same-origin (loaded via /proxy/), so we can
      // target our own origin.
      iframeWin.postMessage(
        { type: 'singlefile-save', url: currentUrl, options: {} },
        window.location.origin
      );

      // Timeout
      const timeout = setTimeout(() => {
        setStatus('Timed out waiting for page processing. The page may be too large or complex.', 'error');
        DOM.saveBtn.disabled = false;
      }, 60000);

      window.__singlefileTimeout = timeout;

    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
      DOM.saveBtn.disabled = false;
    }
  }

  // ── Handle messages from the iframe ───────────────────────────────

  function handleIframeMessage(event) {
    if (event.data && event.data.type === 'singlefile-result') {
      clearTimeout(window.__singlefileTimeout);

      const result = event.data.data;
      savedResult = result;

      if (result.error) {
        setStatus(`Error: ${result.error}`, 'error');
        DOM.saveBtn.disabled = false;
        return;
      }

      const contentLength = result.content ? result.content.length : 0;
      const resourceCount = result.resources ? result.resources.length : 0;
      const filename = result.filename || `page_${Date.now()}.html`;

      DOM.resultInfo.innerHTML = `
        <dl>
          <dt>Filename</dt>
          <dd>${filename}</dd>
          <dt>Size</dt>
          <dd>${formatSize(contentLength)}</dd>
          <dt>Resources inlined</dt>
          <dd>${resourceCount}</dd>
          <dt>URL</dt>
          <dd>${result.url || currentUrl}</dd>
        </dl>
      `;
      DOM.resultInfo.classList.add('visible');

      setStatus('✅ Page saved successfully!', 'success');
      DOM.saveBtn.disabled = false;
      DOM.downloadBtn.style.display = 'inline-block';
    }
  }

  // ── Download result ─────────────────────────────────────────────

  function downloadResult() {
    if (!savedResult || !savedResult.content) return;

    const content = savedResult.content;
    const filename = savedResult.filename || `page_${Date.now()}.html`;

    let blob;
    if (typeof content === 'string') {
      blob = new Blob([content], { type: 'text/html;charset=utf-8' });
    } else if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
      blob = new Blob([content], { type: 'text/html' });
    } else if (Array.isArray(content)) {
      blob = new Blob([new Uint8Array(content)], { type: 'application/zip' });
    } else {
      blob = new Blob([JSON.stringify(content)], { type: 'text/html' });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`✅ Downloaded: ${filename}`, 'success');
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function setStatus(text, type) {
    DOM.statusText.textContent = text;
    DOM.statusText.className = type || '';
    DOM.spinner.classList.toggle('active', type === 'loading');
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
  }

  // ── Iframe load handler ──────────────────────────────────────────

  DOM.proxyFrame.addEventListener('load', () => {
    DOM.saveBtn.disabled = false;
    setStatus('Page loaded in proxy. Click "Save as Single File" to process.', '');
  });

  console.log('SingleFile PWA initialized');
})();