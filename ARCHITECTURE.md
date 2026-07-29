# SingleFile Archiver — Architecture Overview

A serverless page archiver that produces fully self-contained HTML files using **Cloudflare Browser Run** + a headless Chromium running SingleFile-style DOM serialization. Runs entirely on Cloudflare's free tier.

## Why Another Approach?

The existing [PWA-based proof of concept](./singlefile-pwa/) serializes pages inside a browser iframe via a Service Worker proxy. It works, but it requires a live browser tab and a CORS-capable SW scope. This architecture replaces the client-side approach with a **serverless edge service**: no browser tab needed, no CORS issues, no SW dependency — just an HTTP endpoint you call from anywhere.

## System Context

```
┌─────────────────┐     POST /archive?url=…      ┌─────────────────────────────────────────┐
│  Caller          │ ────────────────────────────► │  Cloudflare Worker                      │
│  (CLI, cron,     │                               │                                         │
│   script, PWA)   │                               │  1. Validates URL                       │
│                  │ ◄──────────────────────────── │  2. Acquires browser slot from DO       │
│  Response:       │    200 OK + R2 key / direct   │  3. Launches Browser Run session        │
│  { key, url,     │          download             │  4. Serializes, stores to R2            │
│    size, ... }   │                               │  5. Releases slot back to DO            │
│                  │                               └──────────┬──────────────────────────────┘
│                  │                                          │
│                  │                                          │ RPC: borrowSession()
│                  │                                          │      returnSession()
│                  │                                          ▼
│                  │                               ┌─────────────────────────────────────┐
│                  │                               │  Durable Object                    │
│                  │                               │  (browser-pool)                     │
│                  │                               │                                     │
│                  │                               │  State:                              │
│                  │                               │    active: 0..3                      │
│                  │                               │    queue: [] (waiting callers)       │
│                  │                               │    dailyBudget: ms used today        │
│                  │                               │                                     │
│                  │                               │  borrowSession():                     │
│                  │                               │    if active < 3 → active++ → OK     │
│                  │                               │    else → push caller to queue       │
│                  │                               │           → await (holds RPC open)   │
│                  │                               │                                     │
│                  │                               │  returnSession():                     │
│                  │                               │    active--                          │
│                  │                               │    if queue.length > 0 → resolve next │
│                  │                               └──────────┬──────────────────────────┘
│                  │                                          │
│                  │                                          │ puppeteer.connect()
│                  │                                          ▼
│                  │                               ┌─────────────────────────────┐
│                  │                               │  Cloudflare Browser Run      │
│                  │                               │  (headless Chromium)         │
│                  │                               │                              │
│                  │                               │  ┌───────────────────────┐  │
│                  │                               │  │ page.goto(url)         │  │
│                  │                               │  │ page.evaluate()        │  │
│                  │                               │  │ ← serialization       │  │
│                  │                               │  │   script returns       │  │
│                  │                               │  │   self-contained       │  │
│                  │                               │  │   HTML string          │  │
│                  │                               │  └───────────────────────┘  │
│                  │                               └─────────────────────────────┘
│                  │                                          │
│                  │                                          │ result stored
│                  │                                          ▼
│                  │                               ┌─────────────────────┐
│                  │                               │  Cloudflare R2       │
│                  │                               │  (object storage)    │
│                  │                               │  Bucket: archives    │
│                  │                               │  Key: ts__sha1.html  │
│                  │                               └─────────────────────┘
```

## Architecture Decisions

### Why Browser Run (not a plain Worker)?

A plain Cloudflare Worker has no DOM, no JS runtime, and no CSS engine. It can fetch raw HTML and inline external `<link rel="stylesheet">` references, but it **cannot**:

- Execute JavaScript on the page (SPAs return only a shell)
- Read `getComputedStyle()` for dynamic styles
- Access the CSSOM (styles injected by JS frameworks)
- Capture `<canvas>` or WebGL content
- Read `@font-face` rules loaded after page load
- Walk Shadow DOM trees

Browser Run gives us a real headless Chromium on the edge. The serialization runs **inside the browser context**, not on the Worker's CPU budget — so the Worker's 10ms CPU limit is irrelevant to the heavy lift.

### Why CDP / Puppeteer (not the `/snapshot` Quick Action)?

The `/snapshot` endpoint returns rendered HTML + a screenshot, but the HTML output is the DOM serialization after JS execution — **it does not inline CSS, images, or fonts**. You'd still need a second Worker step to inline resources, and the 10ms CPU limit makes that impractical for pages > ~50KB.

Puppeteer via CDP lets us inject arbitrary JavaScript that walks the DOM, serializes computed styles, converts images to data URIs, captures fonts from CSSOM — producing a truly **self-contained single-file HTML** in one round-trip.

## Free Plan Budget

| Resource | Free Tier Limit | Per-Archive Budget | Notes |
|---|---|---|---|---|
| **Browser Run time** | 10 min/day (~600s) | ~2-4s per page | ~150-300 archives/day free |
| **Worker invocations** | 100k/day | 1 per archive | Trivially not the bottleneck |
| **Worker CPU time** | 10ms/request | ~1-2ms | Light — just orchestration |
| **R2 storage** | 10 GB | ~100-500 KB per file | ~20k-100k archives |
| **R2 writes (Class A)** | 1M/month | 1 per archive | 150-300/day = ~5-9k/month |
| **Concurrent browser sessions** | 3 | N/A | Max 3 concurrent archive requests |
| **DO requests** | 100k/day | 2 per archive (borrow + return) | ~400/day, well within limit |
| **DO duration** | 13,000 GB-s/day | ~0.001 GB-s per RPC | Negligible |
| **DO rows written** | 100k/day | ~2 per archive (state updates) | Well within budget |

**10 min/day is generous.** At 3s per page, you get 200 archives daily. That's 6,000/month, or 72,000/year — all free.

## Component Breakdown

### 1. Worker (`src/worker.js`)

The entry point. Thin orchestrator — validates input, acquires a browser slot from the DO pool, runs CDP serialization, stores the result, then releases the slot.

```
POST /archive?url=<encoded_url>
  → 200 { key: "1712345678__a1b2c3.html", url, size, timestamp }
POST /archive?url=<encoded_url>&inline=true
  → 200 (text/html)  ← returns file directly, no R2 round-trip
GET /list?prefix=<prefix>&limit=10
  → 200 [{ key, size, uploaded }]
GET /<key>
  → 200 (text/html)  ← serves archived files from R2
```

**No heavy processing.** The Worker's role is plumbing: parse request, RPC to DO, launch browser, wait for result, store to R2, respond. Should stay well under the 10ms CPU limit.

### 2. Browser Run Session (`@cloudflare/puppeteer`)

Cloudflare's fork of Puppeteer, deployed as a Worker binding. Each request gets a fresh browser context.

```js
import puppeteer from '@cloudflare/puppeteer'

const browser = await puppeteer.launch(env.MYBROWSER)
const page = await browser.newPage()

// Allow pages time to render JS content
await page.goto(url, {
  waitUntil: 'networkidle0',
  timeout: 30000
})

// Run serialization inside the browser
const result = await page.evaluate(serializePage)
```

**Key parameters:**

| Param | Value | Why |
|---|---|---|
| `waitUntil` | `networkidle0` | Wait for all network activity to settle |
| `timeout` | 30s | Generous; most pages finish in 2-4s |
| `viewport` | 1920×1080 | Standard desktop viewport |
| `deviceScaleFactor` | 2 | Retina-quality screenshots if needed |

### 3. Serialization Script (`src/serializer.js`)

The core logic, injected via `page.evaluate()`. A standalone script that serializes the page's full rendered state into a single self-contained HTML file. This is the **same algorithm** SingleFile uses, adapted for CDP injection.

**What it captures:**

| Aspect | Technique |
|---|---|
| **Rendered DOM** | `document.documentElement.outerHTML` after JS execution |
| **Computed styles** | Walk every element, call `getComputedStyle(el)` |
| **External CSS** | Read from `document.styleSheets[i].cssRules` (catches `@import` chains) |
| **Inline styles** | Already in the DOM, pass through |
| **Images** | `<img>` → draw to offscreen `<canvas>` → `.toDataURL()` |
| **CSS backgrounds** | Walk `background-image` URLs in computed styles → fetch → inline as data URI |
| **Fonts** | Read `@font-face` from CSSOM → fetch font files → inline as base64 data URI |
| **Canvas** | `canvas.toDataURL()` on each `<canvas>` element |
| **SVG** | `new XMLSerializer().serializeToString(svg)` |
| **Shadow DOM** | Walk `element.shadowRoot`, serialize open shadow trees |
| **Meta/charset** | Preserve original `<meta charset>`, `<base>`, `<title>` |
| **Scripts** | Inline `<script src>` as `<script>` content (opt-in; can strip non-essential for smaller output) |

**Size management:**

- Images larger than a configurable threshold (default: 1MB each) are excluded rather than stacked (avoiding 50MB output files)
- Fonts over 500KB each are excluded
- The caller can set `maxOutputSize` to truncate if needed

**Output:** A single HTML string with everything base64-inlined. No external dependencies. Opens in any browser, online or offline.

### 4. R2 Bucket (`ARCHIVE`)

Cloudflare R2 for durable storage. No egress fees — serving files from R2 costs nothing beyond the free tier.

```
Bucket: al-collab-archives
Key format: {timestamp_ms}__{sha1_prefix(8)}.html
```

**Key shape rationale:** Timestamp-first for natural chronological sorting in listings. SHA1 prefix for uniqueness under concurrent requests. Human-readable when browsing the bucket.

**Free tier:**
- 10 GB storage
- 1M Class A writes/month (the archive operation)
- 10M Class B reads/month (listing, serving)

### 5. Durable Object — Browser Pool Coordinator (`browser-pool`)

The DO is the linchpin that makes this work on the free plan's 3-concurrent-browser limit without returning errors to callers.

**Why a DO and not a Queue:**

| Dimension | Durable Object (chosen) | Cloudflare Queue |
|---|---|---|
| **Client UX** | HTTP connection stays open; caller gets the result directly | Returns a job ID; caller must poll or set up a webhook |
| **Latency** | Request is held until a slot opens, then processed inline | Message is stored; consumer picks it up asynchronously |
| **State needed** | Active counter + waiting queue + daily budget tracker | Messages have no shared state |
| **DO requests (free)** | 100k/day — 2 RPCs per archive → ~400/day | 1M queue ops/month — also fine |
| **Complexity** | One class, two RPC methods, SQLite-backed | Worker + queue + consumer + polling endpoint |

The DO lets us **hold the HTTP connection open** while the caller waits for a browser slot. The caller gets the result in their original response — no polling, no webhook. A Queue would force every client into a two-round-trip pattern (submit job → poll for completion), which complicates CLI tools and scripts for minimal gain.

**Class: `BrowserPoolDO`**

```ts
interface PoolState {
  active: number        // 0..MAX_CONCURRENT (3)
  queue: QueueEntry[]   // FIFO waiters
  dailyBudgetMs: number // browser ms used today (resets via Alarm at 00:00 UTC)
}

interface QueueEntry {
  // RPC resolver captured at enqueue time — resolved when a slot opens
  resolve: (value: void) => void
  rejectedAt: number    // timestamp for TTL enforcement
}
```

**RPC methods:**

| Method | Behaviour |
|---|---|
| `borrowSession()` | If `active < MAX_CONCURRENT`: increment, return immediately. Else: push caller to queue, **await** (holds RPC open via DO hibernation). When a slot frees up, the next waiter is resolved. |
| `returnSession(sessionMs)` | Decrement `active`. Add `sessionMs` to `dailyBudgetMs`. If queue has waiters, resolve the next one. If daily budget exceeded, set alarm to re-enable at midnight. |
| `getStatus()` | Returns `{ active, queued, dailyBudgetMs }` for health checks. |

**DO Hibernation keeps it free.** When a waiter is queued, the DO can hibernate — it doesn't burn duration charges while waiting. The RPC stub on the Worker side holds the connection open and re-establishes when the DO wakes up to resolve it.

**Budget enforcement.** The DO also tracks cumulative browser milliseconds per day. When `dailyBudgetMs >= 600_000` (10 min), subsequent `borrowSession()` calls immediately throw an error. An `Alarm` resets the counter at 00:00 UTC.

**Wrangler config:**

```toml
[[durable_objects.bindings]]
name = "BROWSER_POOL"
class_name = "BrowserPoolDO"

[[migrations]]
tag = "v1"
new_classes = ["BrowserPoolDO"]
```

## Data Flow (Happy Path)

```
 1. Caller → POST /archive?url=https://example.com
 2. Worker validates URL (scheme, reachable via HEAD)
 3. Worker calls env.BROWSER_POOL.borrowSession() via DO RPC
    3a. If active < 3: DO increments, returns immediately
    3b. If active ≥ 3: DO pushes caller to queue, RPC awaits
        (DO hibernates; HTTP connection held open by Worker)
    3c. When a slot opens, DO resolves the RPC, Worker proceeds
 4. Worker launches Browser Run session via puppeteer.launch()
 5. page.goto(url, { waitUntil: 'networkidle0' })
 6. page.evaluate(serializePage) → self-contained HTML string
 7. browser.close()
 8. Worker computes key: `${Date.now()}__${sha1(url).slice(0,8)}.html`
 9. Worker writes to R2 bucket under that key
10. Worker calls env.BROWSER_POOL.returnSession(elapsedMs)
    10a. DO decrements active counter
    10b. DO adds elapsedMs to daily budget
    10c. If queue has waiters, DO resolves the next one
11. Worker returns { key, url, size, timestamp }
```

## Error Handling

| Failure Mode | Behaviour |
|---|---|
| Invalid/malformed URL | 400 Bad Request |
| URL unreachable (timeout) | 502 with error detail |
| Page requires auth | Attempt fetch; return 401 if blocked |
| Browser session fails | Retry once; return 503 on second failure |
| **All 3 browser slots busy + queue full** | Return 503 with `Retry-After` header (caller backs off) |
| **DO unreachable** | Fall back to synchronous (no throttling); log warning |
| **DO reports daily budget exceeded** | Return 429 with `Retry-After: seconds-until-midnight` |
| R2 write fails | Return 500; caller should retry |
| Page too large (>25MB serialized) | Truncate with warning flag in response |

## Comparison: Worker+Browser Run vs PWA+SW Proxy

| Dimension | Worker + Browser Run (this plan) | PWA + SW Proxy (existing) |
|---|---|---|
| **Runtime** | Edge (Cloudflare global network) | Browser tab (user's device) |
| **Persistent storage** | R2 (10GB free, no egress fees) | Client-side download only |
| **Scriptable** | Exposed HTTP API (call from CLI, cron, scripts) | Manual UI in browser |
| **CORS limitations** | None — browser runs on Cloudflare infra | SW proxy must deal with hotlink/CSP blocks |
| **Browser minutes cost** | 10 min/day free | Zero (uses user's browser) |
| **Page fidelity** | Full SingleFile serialization (computed styles, canvas, fonts, shadow DOM) | Full SingleFile serialization (same core library) |
| **Offline availability** | Archived files always available via R2 | Requires user's device + SW cache |
| **Concurrent archiving** | Up to 3 simultaneous (free plan limit) | N/A (single user browser) |

**They are complementary.** The PWA is great for on-demand manual archiving from a browser. The Worker API is for automated/headless archiving from scripts, cron jobs, or CI pipelines.

## Open Questions

1. **SingleFile-core compatibility in page.evaluate()** — `single-file-core` is designed as a Node/browser library that requires certain globals (`fetch`, `DOMParser`, etc.). In a CDP page.evaluate() context, we're inside the real browser, so those should be available. But the library's bundled size (~1.2MB minified) might hit the 4MB evaluate() result limit. We may need a stripped-down version that only returns the serialized HTML (not the full resource map).

2. **Wrangler + Puppeteer** — Cloudflare's `@cloudflare/puppeteer` requires a Browser Run binding configured in `wrangler.toml`. Need to verify the exact binding syntax and that it's available on free accounts (confirmed yes for the feature itself; the binding should work).

3. **Result size limits** — page.evaluate() returns the result as a serialized string. Worker memory is capped at 128MB (free) / 512MB (bundled). A heavily inlined page with many images could easily be 5-15MB. This should be fine, but worth monitoring.

4. **Unicode/encoding** — R2 is binary-safe, so no issues there. The serialized HTML should declare `<meta charset="utf-8">`.

5. **DO queue stability at low concurrency** — With only 3 concurrent slots, practical contention is low at ~200 pages/day. The queue mostly stays empty. But the DO pattern is essential for burst scenarios (e.g., a batch cron that fires 50 archives at once). Need to confirm DO RPC `await` across hibernation works reliably for multi-second waits.

## Future Iterations

- **Batch archiving** — Accept an array of URLs, process sequentially within the browser session
- **Webhook callback** — For long-running archives, return immediately and POST result to a callback URL
- **Diffing** — Re-archive the same URL and diff the two HTML files (structural diff of the DOM, not string comparison)
- **Cron scheduling** — Regularly archive a set of URLs on a schedule
- **Full-page screenshot companion** — Store a screenshot alongside the HTML for quick visual browsing

## Appendix: Free Plan Cost Walkthrough

| Usage Scenario | Browser Run Time | Monthly Cost |
|---|---|---|
| Personal archiving (10 pages/day) | ~30s/day | $0 |
| Heavy personal (100 pages/day) | ~300s/day (5 min) | $0 |
| Near-limit (150 pages/day) | ~450s/day (7.5 min) | $0 |
| Hard free-plan limit | 600s/day (10 min) = ~200 pages | $0 |
| Above free limit (at $0.09/hr) | ~$0.045/additional 30 minutes | ~$0.05-0.10 |

At $0.09/browser-hour overage, even heavy use costs pennies.