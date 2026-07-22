# SingleFile PWA — Proof of Concept

**Path C: Iframe + Service Worker proxy.** A PWA that saves web pages as single-file HTML archives using the [SingleFile](https://github.com/gildas-lormeau/SingleFile) core library, entirely in the browser.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  PWA (http://localhost:8080)                          │
│                                                        │
│  ┌──────────────────┐    ┌─────────────────────────┐  │
│  │  Main Window      │    │  Service Worker          │  │
│  │                   │    │                          │  │
│  │  <iframe src=     │───►│  Intercepts /proxy/URL   │  │
│  │   "/proxy/URL">   │    │  Fetches real URL (CORS- │  │
│  │                   │    │  free in SW context)     │  │
│  │  [same-origin!]   │◄───│  Injects <base> + core   │  │
│  │                   │    │  Strips CSP headers      │  │
│  │  postMessage()    │──►│  Proxies subresource      │  │
│  │  → core processes │    │  fetches via /fetch-proxy│  │
│  │  ← result back    │    └─────────────────────────┘  │
│  │                   │                                  │
│  │  Download saved   │                                  │
│  └──────────────────┘                                  │
└──────────────────────────────────────────────────────┘
```

**Key insights:**
- The SW proxies `/proxy/URL` → keeps the iframe **same-origin** with the PWA
- Service Workers can `fetch()` cross-origin URLs and read the response body (not subject to CORS)
- The core bundle is **inlined** into the HTML response to avoid mixed-content issues
- The core runs in the iframe's context, processes the live DOM, and sends the result via `postMessage`

## Files

| File | Purpose |
|---|---|
| `index.html` | PWA shell: URL bar, iframe, save/download buttons |
| `app.js` | Main app logic: SW registration, iframe control, postMessage, download |
| `sw.js` | Service Worker: proxy, HTML rewriting, core injection, fetch proxy |
| `core-bundle.js` | Bundled SingleFile core (1.2MB, built from `single-file-core`) |
| `manifest.json` | PWA manifest for installable offline support |
| `icons/` | PWA icons |
| `src/core-entry.js` | Entry point for bundling single-file-core with custom fetch |
| `build-bundle.js` | esbuild script to build core-bundle.js |

## How to Run

```bash
cd singlefile-pwa
python3 -m http.server 8080
```

Then open http://localhost:8080 in a browser that supports Service Workers.

**Important:** The SW must be served from a **localhost** or **HTTPS** origin for registration to work.

## How to Use

1. Enter a URL (e.g., `https://example.com`)
2. Click **Load** — the page appears in the iframe via the SW proxy
3. Click **Save as Single File** — the core processes the page
4. Click **Download** to save the result

## Limitations

- **CORS on subresources**: The core's resource fetching goes through the SW's `/fetch-proxy` which works for many resources, but some sites may block hotlinking
- **Dynamic JS-rendered pages**: The core processes the page as rendered in the iframe, so JS-executed content is captured. But the proxy may break some JS that depends on `window.location` being the real URL
- **Large pages**: The core bundle is 1.2MB inlined into every HTML response. For production, cache the bundle separately
- **Offline**: The SW caches the PWA shell, but fetching new pages requires network connectivity

## Production Considerations

- Serve over HTTPS (required for SW in production)
- Consider caching the core bundle separately (not inlined) using a CDN
- The SW's `fetch()` to the target URL may be blocked by some sites' firewall/CDN (Cloudflare, etc.)
- For heavy use, rate-limit the proxy or add a backend CORS proxy

## License

AGPL-3.0 (inherited from single-file-core)