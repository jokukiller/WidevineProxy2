# PW Pi Lecture Crawler — Full Handoff Document

## 1. Project Context

**Goal:** Automate discovery and cataloging of all PW Pi lectures from `https://www.pw.live/study-v2/pi`. Currently, scraping PW Pi lectures with WidevineProxy2 requires manually navigating to each lecture, clicking play, and waiting for key capture — one at a time. The crawler targets the entire Pi content tree to produce a structured catalog of all lectures with URLs/IDs for later batch key capture.

**Scope:** PW Pi only — the user has access exclusively to PW Pi content.

**Platform:** PW uses a React SPA backed by `api.penpencil.co/v3/` REST endpoints with Bearer token authentication. The extension runs in the same browser, so it can reuse the user's auth token.

**Production codebase path:** `H:\PIRATE-WALLAH\workspace\widevineproxyoriginal\WidevineProxy2-crawler`

---

## 2. What Has Been Built

### Task 1: API Discovery & Interception Layer ✅

**File:** `content_script.js`

Added network interception that captures ALL requests to `*penpencil.co*`:
- **XHR interception** (lines ~780-837): Proxies `XMLHttpRequest.setRequestHeader` to capture outgoing headers, and `XMLHttpRequest.send` to capture responses including full response headers via `getAllResponseHeaders()`.
- **Fetch interception** (lines ~892-960): Proxies `window.fetch` to capture request headers from both `Request` objects and init options, plus response headers from `response.headers`.
- **IPC mechanism**: Captured data is sent to background via `document.dispatchEvent(new CustomEvent('response', { detail: { type: "API_CAPTURED", body: JSON.stringify(data) } }))` — the production content script uses `'response'`/`'responseReceived'` event names (NOT the randomized `wvp2_ipc_*` pattern used in the test copy).

Each captured entry includes:
- `url` (final response URL)
- `originalUrl` (requested URL before redirects)
- `method`
- `requestHeaders` (full headers sent, including Authorization)
- `responseHeaders` (full headers received)
- `responseBody` (parsed JSON or raw text — NOT truncated)
- `statusCode`
- `source` ('xhr' or 'fetch')
- `timestamp`

### Task 2: Auth Token Extraction ✅

**File:** `background.js` — `updateAuthToken()` function (lines ~52-99)

When any `API_CAPTURED` message arrives, `updateAuthToken()`:
1. Scans request headers for `Authorization: Bearer <token>`
2. Extracts the token
3. **Also captures ALL non-browser-managed headers** as a "header template" — strips `sec-*`, `cookie`, `user-agent`, `host`, etc., keeps PW-specific headers like `Client-Service`, `app-version`, `os`, `time-zone`, `device-token`, etc.
4. Falls back to defaults: `Client-Service: frontend`, `app-version: 5.1.2`
5. Stores everything in `chrome.storage.local` under key `pwAuthToken` with structure:
```json
{
  "token": "<jwt>",
  "capturedAt": 1234567890,
  "expiresAt": null,
  "capturedHeaders": {
    "Client-Service": "frontend",
    "app-version": "5.1.2",
    "os": "android",
    "time-zone": "Asia/Kolkata",
    ...
  }
}
```

### Task 3: Content Tree Crawler Engine ✅

**File:** `crawler.js` (standalone ES module, ~650 lines)

`PWCrawler` class with:
- **Configurable endpoint map** (`DEFAULT_ENDPOINTS`):
  ```js
  {
    allBatches: '/v3/batches/all-purchased-batches',  // CONFIRMED endpoint
    batchSubjects: '/v3/batches/{batchId}/subjects',  // PLACEHOLDER — needs discovery
    subjectChapters: '/v3/subjects/{subjectId}/chapters',  // PLACEHOLDER
    chapterContents: '/v3/chapters/{chapterId}/contents',  // PLACEHOLDER
  }
  ```
  **⚠️ CRITICAL:** Only `allBatches` is confirmed. The other three are **guessed** paths that need to be updated based on real API data from the debug dump.

- **Auth**: Loads token + captured headers from `chrome.storage.local`. Sends captured headers on every request, overriding with fresh `Authorization`.
- **Pagination**: `apiRequestAllPages()` handles `page`/`limit` params, multiple response shape patterns (`data`, `results`, `batches`).
- **Retry logic**: 3 retries with exponential backoff on 5xx/network errors. 429 = 10s wait. 401 = immediate stop.
- **Pause/Resume/Stop**: Full state machine (`idle` → `crawling` → `paused`/`completed`/`stopped`/`error`).
- **Persistence**: `serializeState()` / `restoreState()` for saving/restoring crawl state.
- **Debug hooks**: `onProgress` callback for UI updates, `onDebug` callback for detailed request/response logging.
- **Output format**:
```json
{
  "crawlId": "pi_1234567890",
  "startedAt": "...",
  "completedAt": "...",
  "status": "completed",
  "batches": [{
    "batchId": "...",
    "batchName": "...",
    "subjects": [{
      "subjectId": "...",
      "subjectName": "...",
      "chapters": [{
        "chapterId": "...",
        "chapterName": "...",
        "lectures": [{
          "lectureId": "...",
          "title": "...",
          "type": "OTT",
          "watchUrl": "https://www.pw.live/watch/?batchId=...&childId=...",
          "duration": null,
          "hasCapturedKey": false
        }]
      }]
    }]
  }]
}
```

### Task 4: Crawler UI Panel ✅

**Files:** `panel/panel.html`, `panel/panel.js`, `panel/panel.css`

Full crawler section added to the extension panel:
- **Auth Token Status**: Green/red indicator with token preview and captured header list
- **Controls**: "Crawl PW Pi" button, depth selector (Full Tree/Widgets Only), rate limit slider (200ms-2000ms)
- **Progress display**: State label, current crawl path, progress bar, stats grid (batches/subjects/chapters/lectures counts), expandable error log
- **Results tree**: Collapsible tree visualization of batches → subjects → chapters → lectures. Lectures with captured keys show 🔑 icon in green.
- **Export buttons**: Export JSON (full tree), Export URLs (flat list), Copy URLs to clipboard
- **API Recording section**: Toggle, clear, count, expandable list of captured APIs
- **Crawl History section**: Collapsible list of past crawls with status, date, stats, key match count, and "Load" button to restore any past result

### Task 5: Integration & State Persistence ✅

**File:** `background.js` — persistence helpers + message handlers

- **`saveCrawlSnapshot()`**: Saves current crawl state to `chrome.storage.local` key `pwCrawlSnapshot` every 10 seconds during crawling.
- **`saveCrawlToHistory()`**: On crawl completion/stop, saves to `pwCrawlHistory` array (max 20 entries, newest first). Cross-references lecture URLs against captured key logs to mark `hasCapturedKey`.
- **`restoreLastCrawlState()`**: Called on module load — restores last saved state so results survive browser restart.
- **Message handlers**: `CRAWL_GET_HISTORY`, `CRAWL_CLEAR_HISTORY`, `CRAWL_RESTORE_HISTORY`, `CRAWL_CROSSREF_KEYS`

### Debug Dump System ✅

**Purpose:** Comprehensive data capture for offline analysis (since the developer can't see the browser directly).

**Components:**
1. **`crawlDebug()` ring buffer** (`background.js`): Stores last 300 debug events with timestamps. Broadcasts each event to open panels via `CRAWL_DEBUG_EVENT` message.
2. **`crawlApiLog` array** (`background.js`): Stores last 500 full-detail API captures (complete request headers, response headers, response bodies).
3. **Crawler `onDebug` hook**: Emits `crawler_request` (URL, headers sent, token preview, captured header keys) and `crawler_response` (status, response header keys, body preview) events for every API call the crawler makes.
4. **"Export Debug Dump" button** (top of crawler section in panel): Downloads a JSON file containing:
   - `authToken`: token preview, captured timestamp, all captured headers and their values
   - `capturedApiPatterns`: deduplicated endpoint list with request header keys, response header keys, response body previews
   - `fullApiLog`: every API call with full headers and bodies (up to 500)
   - `crawlerState`: current crawler state, progress, full results
   - `debugEvents`: timestamped event timeline

---

## 3. Architecture & Key Technical Details

### IPC Flow
```
content_script.js (MAIN world)
  → document.dispatchEvent('response', { detail: { type, body } })
  → message_proxy.js (ISOLATED world) listens for 'response' events
  → chrome.runtime.sendMessage({ type, body })
  → background.js onMessage handler
  → sends response via document.dispatchEvent('responseReceived')
```

For `API_CAPTURED`, the flow is fire-and-forget (no `requestId` in the event detail, so message_proxy skips the response dispatch).

### Key Differences from Test Copy
The workspace root has `WidevineProxy2/` which was a **test/sandbox copy** used by previous sub-agents. The production copy is at `widevineproxyoriginal/WidevineProxy2-crawler/`. Key differences:
- Production content_script uses `'response'`/`'responseReceived'` events (not randomized `wvp2_ipc_*`)
- Production has full class title tracking, watched lecture overlay, home URL trigger, duplicate detection
- Production background.js uses `chrome.storage.local` for debug events (not in-memory array)
- Production uses `video_title`/`class_title` field names (not `videoTitle`/`classTitle`)

### Manifest
No changes were made to `manifest.json`. The crawler module is loaded via the existing `background.js` ES module import system.

---

## 4. Known Issues & Blockers

### 🔴 Issue: Crawler Gets 401 "Token Expired" Immediately

**Symptom:** Token indicator turns green (token captured successfully), but clicking "Crawl PW Pi" immediately fails with 401.

**Root cause hypothesis (UNCONFIRMED — need debug dump data):**
1. **Missing required headers**: PW's API may require specific headers beyond what's captured. Common PW headers include: `Client-Service`, `app-version`, `os`, `device-token`, `time-zone`, `Accept-Language`, `lat`, `lng`. The current code captures headers from intercepted requests and replays them, but the captured set may be incomplete or the header values may be page-specific.
2. **Token binding**: The JWT may be bound to the page session via cookies or other browser context that `fetch()` from the service worker doesn't include. Service workers don't automatically send cookies with cross-origin fetch requests.
3. **CORS preflight**: The service worker's `fetch()` to `api.penpencil.co` may trigger a CORS preflight that fails, since the extension's origin is different from `pw.live`.
4. **Endpoint paths wrong**: If the first request hits a 404 or redirects, the error may be misreported as 401.

**How to diagnose:** Click "Export Debug Dump" after:
1. Navigating to PW Pi and browsing for 30 seconds (captures API patterns)
2. Attempting a crawl (captures crawler's request/response details)

The dump will show:
- Exactly which headers PW's frontend sends
- Exactly which headers the crawler sent
- The exact 401 response body (which usually contains PW's error message)

### 🟡 Placeholder Endpoint Paths

Only `/v3/batches/all-purchased-batches` is confirmed. The content tree traversal endpoints (`batchSubjects`, `subjectChapters`, `chapterContents`) are **guessed** and need to be updated from real API data. The debug dump's `capturedApiPatterns` will reveal the actual endpoint paths.

**GitHub reference:** `viraj-sh/pw-client` may have documented endpoints to cross-reference.

---

## 5. File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `background.js` | ~1200 | Main service worker. Handles all message routing, auth token capture, crawler lifecycle, persistence, debug logging. |
| `content_script.js` | ~1470 | Injected into MAIN world. API interception (fetch + XHR), class title tracking, watched lecture overlay. |
| `crawler.js` | ~650 | Standalone ES module. `PWCrawler` class — recursive content tree crawler with retry, pagination, pause/resume. |
| `message_proxy.js` | ~66 | ISOLATED world bridge between content_script events and chrome.runtime messages. |
| `panel/panel.html` | ~210 | Extension popup HTML. |
| `panel/panel.js` | ~860 | Extension popup logic including full crawler UI. |
| `panel/panel.css` | ~250 | Extension popup styles including crawler dark/light mode. |
| `manifest.json` | ~53 | MV3 manifest. No crawler-specific changes. |

---

## 6. Message Handler Reference

| Message Type | Direction | Purpose |
|-------------|-----------|---------|
| `API_CAPTURED` | content → background | Full API call data from interception |
| `GET_AUTH_TOKEN` | panel → background | Returns stored auth token |
| `GET_CAPTURED_APIS` | panel → background | Returns deduplicated API patterns |
| `CLEAR_CAPTURED_APIS` | panel → background | Clears captured APIs map |
| `TOGGLE_API_RECORDING` | panel → background | Enable/disable API recording |
| `CRAWL_START` | panel → background | Start crawl with `{ depth, delayMs }` |
| `CRAWL_PAUSE` | panel → background | Pause active crawl |
| `CRAWL_RESUME` | panel → background | Resume paused crawl |
| `CRAWL_STOP` | panel → background | Stop crawl, save to history |
| `CRAWL_GET_STATE` | panel → background | Returns `{ state, progress }` |
| `CRAWL_GET_RESULTS` | panel → background | Returns full results tree |
| `CRAWL_GET_HISTORY` | panel → background | Returns history array |
| `CRAWL_CLEAR_HISTORY` | panel → background | Clears crawl history |
| `CRAWL_RESTORE_HISTORY` | panel → background | Restores a past crawl by `crawlId` |
| `CRAWL_CROSSREF_KEYS` | panel → background | Cross-references results with captured keys |
| `CRAWL_GET_DEBUG_LOG` | panel → background | Returns debug event ring buffer |
| `CRAWL_CLEAR_DEBUG_LOG` | panel → background | Clears debug events + API log |
| `CRAWL_EXPORT_DEBUG` | panel → background | Returns comprehensive debug dump object |
| `CRAWL_PROGRESS` | background → panel | Broadcast during crawl (2s polling backup) |
| `CRAWL_DEBUG_EVENT` | background → panel | Broadcast each debug event in real-time |

---

## 7. Storage Keys

| Key | Type | Purpose |
|-----|------|---------|
| `pwAuthToken` | Object | `{ token, capturedAt, expiresAt, capturedHeaders }` |
| `pwCrawlSnapshot` | Object | Serialized crawler state for resume after restart |
| `pwCrawlHistory` | Array | Last 20 crawl results with metadata |

---

## 8. Next Steps for Successor

1. **Get a debug dump**: Have the user click "Export Debug Dump" after browsing PW Pi. Analyze the JSON to determine:
   - Actual endpoint paths (from `capturedApiPatterns`)
   - Required request headers (from `fullApiLog[].requestHeaders`)
   - Response shapes (from `fullApiLog[].responseBody`)
   - Why crawler gets 401 (from `debugEvents` where `type === 'crawler_auth_error'`)

2. **Update `DEFAULT_ENDPOINTS`** in `crawler.js` with real paths discovered from the dump.

3. **Fix the 401 issue**: Based on the dump, likely fixes include:
   - Adding missing headers to the request
   - Adding `credentials: 'include'` to fetch calls (if cookie-based auth is needed)
   - Adjusting CORS handling
   - Using `chrome.declarativeNetRequest` to add headers instead of fetch

4. **Test on a small crawl**: Once auth works, run a depth-limited crawl and verify results match what's visible on the PW page.

5. **Consider**: The PW API may use GraphQL or have a different structure than the assumed REST hierarchy. The debug dump will reveal this.

---

## 9. Test Status

All 24 existing tests pass:
- `test/sanity.test.js` (2 tests)
- `test/helpers.smoke.test.js` (17 tests)
- `test/settingsManager.logExportName.property.test.js` (2 tests)
- `test/exportPayload.property.test.js` (2 tests)
- `test/exportFilename.property.test.js` (1 test)

Run with: `cd WidevineProxy2-crawler && npx vitest run`

---

## 10. Original Spec Reference

The original plan spec is at: `H:\PIRATE-WALLAH\workspace\.qoder\specs\PW_Lecture_Crawler_Module_01dfd2e1.md`
