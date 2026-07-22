// Service Worker for SingleFile PWA
// Acts as a reverse proxy: intercepts /proxy/URL requests, fetches the
// target page, injects the core processing script, and returns the
// modified HTML. The iframe stays same-origin, so the PWA can
// communicate with the core script via postMessage.

const CACHE_NAME = 'singlefile-pwa-v1';
const CORE_BUNDLE_PATH = '/core-bundle.js';

const PRECACHE_ASSETS = [
  '/', '/index.html', '/app.js', CORE_BUNDLE_PATH,
  '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png',
];

// ── Install & Activate ────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))),
      self.clients.claim(),
    ])
  );
});

// Cache the core-bundle source so we can inline it into HTML responses
let coreBundleSource = null;
async function getCoreBundleSource() {
  if (coreBundleSource) return coreBundleSource;
  try {
    const res = await fetch(CORE_BUNDLE_PATH);
    coreBundleSource = await res.text();
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(CORE_BUNDLE_PATH);
    if (res) coreBundleSource = await res.text();
  }
  return coreBundleSource;
}

// ── Fetch handler ─────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Serve core bundle from cache or network
  if (url.pathname === CORE_BUNDLE_PATH) {
    event.respondWith(fromCacheOrNetwork(event.request));
    return;
  }

  // PWA assets: network-first, cache fallback
  if (url.origin === self.location.origin && !url.pathname.startsWith('/proxy/') && url.pathname !== '/fetch-proxy') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Fetch proxy: relay subresource requests without CORS
  if (url.pathname === '/fetch-proxy') {
    event.respondWith(handleFetchProxy(url));
    return;
  }

  // Page proxy: /proxy/<target-url>
  if (url.pathname.startsWith('/proxy/')) {
    event.respondWith(handlePageProxy(url));
  }
});

// ── Page proxy: fetch HTML, inject base + core, strip CSP ─────────
async function handlePageProxy(url) {
  // Extract target URL — it's after /proxy/
  let targetUrl = decodeURIComponent(url.pathname.slice('/proxy/'.length));
  // If the URL has query params, reconstruct them
  if (url.search) targetUrl += url.search;
  if (url.hash) targetUrl += url.hash;

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    // Fetch the target URL. In a Service Worker, fetch() can read
    // cross-origin responses — this is a key SW capability.
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SingleFile-PWA/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      // Non-HTML: pass through with CORS headers
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    }

    let html = await response.text();

    // Normalize base URL
    const baseUrl = targetUrl.replace(/\/$/, '') + '/';

    // 1. Inject <base> tag so relative URLs resolve against the real site
    html = html.replace(/<base[^>]*>/gi, '');
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${baseUrl}">\n`);

    // 2. Inject core bundle as inline script (avoids mixed-content issues)
    const coreSource = await getCoreBundleSource();
    if (coreSource) {
      const inlineScript = `<script>${coreSource}</script>`;
      if (html.includes('</head>')) {
        html = html.replace('</head>', `${inlineScript}\n</head>`);
      } else {
        html = html.replace('</body>', `${inlineScript}\n</body>`);
      }
    }

    // 3. Strip security headers that would block inline execution
    const headers = new Headers(response.headers);
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.delete('x-frame-options');
    headers.delete('x-content-security-policy');
    headers.delete('x-webkit-csp');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(html, {
      status: response.status, statusText: response.statusText, headers,
    });
  } catch (err) {
    return new Response(
      `Proxy error: ${err.message}`,
      { status: 502, headers: { 'Content-Type': 'text/plain' } }
    );
  }
}

// ── Fetch proxy: relay subresource fetches without CORS issues ────
async function handleFetchProxy(url) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return new Response('Missing url', { status: 400 });

  try {
    const response = await fetch(targetUrl);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers,
    });
  } catch (err) {
    return new Response(`Fetch error: ${err.message}`, { status: 502 });
  }
}

// ── Cache helpers ─────────────────────────────────────────────────
async function fromCacheOrNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}