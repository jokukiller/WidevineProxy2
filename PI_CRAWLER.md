# PW Pi Crawler — Working Notes & Handoff

State as of this session. This supersedes the older `CRAWLER_HANDOFF.md`
(which described a wrong `batch→subject→chapter→lecture` model and is kept only
for history). The crawler now works end-to-end and has produced the full PW Pi
catalog.

---

## 1. Goal

Catalog **all** PW Pi lectures from `pw.live/study-v2/pi` into a structured form
so we can (a) batch-capture Widevine keys/manifests per unique video and
(b) reconstruct the content tree on piratewallah.

## 2. The real PW Pi content model (confirmed live)

PW Pi is **NOT** batches/subjects/chapters. The real hierarchy, and how it maps
to our 5 internal levels:

| our level    | PW concept | id in watch URL | endpoint |
|--------------|------------|-----------------|----------|
| main-branch  | root category (e.g. GATE)        | (parent of categoryId) | `ott/v1/ott/category` |
| sub-branch   | child category (e.g. CSE)        | `categoryId`    | `ott/v1/ott/category?parentId=<root>` |
| subject      | widget / content shelf           | `widgetId`      | `ott/v1/ott/widget?categoryId=&landingPage=HOME` |
| class        | playlist                         | `playlistId`    | (item inside widget content) |
| lecture      | video                            | `childId`       | `ott/v1/ott/widget/{widgetId}/content?categoryId=&page=` |

**Confirmed endpoints (all on `https://api.penpencil.co`, GET, Bearer JWT):**
- `ott/v1/ott/category` → ROOT categories only (`isRoot:true`, `childCount`).
- `ott/v1/ott/category?parentId={id}` → child categories (recurse to build the tree).
- `ott/v1/ott/widget?categoryId={id}&landingPage=HOME` → widgets (shelves) for a category. **Metadata only** (title, `type`, `categoryIds`) — no items.
- `ott/v1/ott/widget/{widgetId}/content?categoryId={id}&page={n}` → **the items** (videos + playlists). Paginated; stop when `paginate.totalPending <= 0` or page empty.
- `ott/v1/ott/playlist/{playlistId}` → playlist detail. **Videos live in `data.ottVideoDetails[]`** (NOT `data.chapters[]`, which is just `{id,name,count}` metadata).

**Watch URL format:**
- single video: `/watch/?categoryId=&widgetId=&childId=`
- playlist video: `/watch/?categoryId=&widgetId=&playlistId=&childId=&default_enabled_feature=PLAYLIST`

### Widget types (curriculum vs promotional)
Only **`Generic Widget`** holds real curriculum (subjects like "Engineering
Mathematics", "Arjuna 2.0 Physics", "11th NEET PYQs"). Everything else is a
promotional rail or non-lecture and is **excluded from the catalog tree** (but
still captured as assets, and logged to orphans if they have no curriculum home):
`Hero Banner`, `Top X Content`, `Recommendations`, `Continue Watching`,
`Teacher Widget`, `Free Widget`, `Subject Widget`, plus non-video types
`Live`, `Upcoming Content`, `Practice Widget`, `Generic Test Widget`,
`Redirection Widget`.

## 3. Architecture

- **`crawler.js`** — `PWCrawler` class. `crawlPiTree('full')` does an **active
  crawl**: BFS the category tree → for each category fetch widgets → for each
  widget paginate `widget/{id}/content` → classify items (video|playlist) →
  expand each **unique** playlist once via `ott/v1/ott/playlist/{id}` and assign
  its videos to every occurrence. `crawlPiTree('harvest')` parses already-captured
  traffic only (no requests).
- **Transport**: requests run from the **service worker** with the captured JWT +
  PW headers (`_defaultTransport`). Proven to return 200. A page-context transport
  (`pwPageFetch` in background.js, via `PW_PAGE_FETCH` in message_proxy.js) also
  exists as an alternative.
- **`background.js`** — token capture (`updateAuthToken`, JWT-only), crawl
  lifecycle, and compact result messaging: `CRAWL_GET_SUMMARY` (counts) and
  `CRAWL_GET_FLAT` (deduped flat list). The full result tree is **>64 MB** and is
  never sent over `chrome.runtime` messaging. History stores counts only.
- **`content_script.js`** — MAIN-world fetch/XHR interception → `API_CAPTURED`.
  Includes a `[WVP2-Capture]` diagnostic log (page console).
- **panel** — shows the compact summary + category list; Export = deduped flat
  catalog / URLs.

## 4. Data model (the normalized output)

Produced into `../crawler-output/` (sibling of the extension; never inside it):

- **`pi-assets.json`** — one row per unique `childId` (the **scrape unit** for
  manifest/keys). Fields: `childId, videoId, title, duration, curriculumPlacements`.
- **`pi-placements.json`** — every real curriculum position. Fields:
  `childId, mainBranchId/mainBranch, subBranchId/subBranch, subjectId/subject,
  classId/class, lecture, watchUrl`. The same asset can have many placements
  (cross-branch reuse) — all preserved.
- **`pi-discovery-orphans.json`** — assets with **0** curriculum placements
  (seen only in promotional widgets) + where they were seen. Safety net.

### Latest counts (corrected run)
```
categories (tree)        : 79
widgets                  : 1091
playlist entries         : 6512   (4581 unique)
lecture placements (raw) : 50296
unique assets (childId)  : 32151
curriculum placements    : 43789
assets in >1 branch      : 6831
orphans                  : 145
```

### Why dedupe is by `childId`, not name
`childId` is PW's per-video content id (1:1 with content — verified: 0 childIds
map to >1 title). Same-named lectures in different classes/branches have
**different** childIds and are all kept. Only identical assets re-listed across
promo shelves collapse. Watch URLs/keys are a property of the asset, so capture
once per `childId`, render many placements.

## 5. CDP debug toolkit — `cdp-debug.mjs`

Drives Opera GX (Chromium) over the DevTools Protocol. **Prereq:** launch Opera
fully quit, then:
```
& "C:\Users\anas\AppData\Local\Programs\Opera GX\opera.exe" --remote-debugging-port=9222
```
Extension id (WidevineProxy2, our dev copy): `pkoikjplcdkipeogmopelecfnfpaddcl`.

```
node cdp-debug.mjs targets                         # list CDP targets
node cdp-debug.mjs diagnose 14 <extId>             # reload Pi, watch consoles, read token
node cdp-debug.mjs netauth <urlSub> <secs>         # log penpencil Authorization headers
node cdp-debug.mjs netall <urlSub> <secs>          # log all XHR/Fetch endpoints (scrolls)
node cdp-debug.mjs apiget <extId> <apiPath>        # GET an api endpoint via the SW (shows shape+sample)
node cdp-debug.mjs reloadext <extId>               # chrome.runtime.reload()
node cdp-debug.mjs crawl <extId> [full|harvest] [delayMs]   # start + poll a crawl
node cdp-debug.mjs status <extId>                  # crawl progress (lightweight)
node cdp-debug.mjs extract <extId> <outBase>       # deduped flat catalog -> <outBase>.json/-urls.txt
node cdp-debug.mjs normalize <extId> <outBase>     # assets/placements/discovery-orphans -> ../crawler-output
node cdp-debug.mjs widgetstats <extId>             # widget-type breakdown
node cdp-debug.mjs dupcheck <extId>                # dedup integrity analysis
```
Notes: the SW idles (MV3); commands wake it via the panel page. Opera sometimes
refuses `Target.createTarget` ("Failed to open a new tab") — `getPanelSession`
falls back to reusing an existing tab.

## 6. Bugs found & fixed this session

1. **Duplicate extension** — a second/older WidevineProxy2 (`opdjhjgh…`) won the
   content-script injection race (shared `__widevineProxy2ContentScriptLoaded`
   guard), capturing the token into the wrong storage. **Fix:** user disabled the
   duplicate; keep only the dev copy.
2. **Wrong token** — `updateAuthToken` grabbed the first `Authorization` header,
   which was an **Unleash** feature-flag key (`*:production…`). **Fix:** accept
   only `Bearer eyJ…` JWTs.
3. **`message_proxy.js` crash flood** — `detail.requestId.concat` threw on every
   fire-and-forget `API_CAPTURED`. **Fix:** guard + try/catch.
4. **Wrong content model** — discovered the real `category→widget→content→playlist`
   endpoints live; replaced the guessed model with an active crawl.
5. **`videoId` vs `_id` (critical)** — playlist videos in `ottVideoDetails[]`
   carry both `_id` (content; used by watch URLs) and `videoId` (media). The
   classifier picked `videoId`, so ~47k playlist lectures had wrong childIds /
   watch URLs. **Fix:** `classifyItem` uses content `_id`, keeps `videoId` as an
   info field. (Orphans 669→145, assets 33,114→32,151 after fix.)
6. **64 MB messaging limit** — added `CRAWL_GET_SUMMARY`/`CRAWL_GET_FLAT`; history
   no longer embeds the tree.
7. **Reserved `_` filenames** — scratch scripts named `_probe_*.mjs` in the
   extension dir broke extension loading ("Filenames starting with _ are
   reserved"). **Fix:** deleted; tool output now goes to `../crawler-output/`.

## 7. How to run a fresh full crawl
1. Be logged in to PW Pi in Opera (launched with `--remote-debugging-port=9222`).
2. `node cdp-debug.mjs crawl pkoikjplcdkipeogmopelecfnfpaddcl full 40`
   (active crawl; ~12 min — category BFS then ~4.5k unique playlist expansions).
3. `node cdp-debug.mjs normalize pkoikjplcdkipeogmopelecfnfpaddcl ../crawler-output/pi`
4. Verify: `node ../crawler-output/verify.mjs`.

## 8. Open items / next steps
- **145 orphans** — review `pi-discovery-orphans.json`; decide placements.
- **Manifest/Widevine key capture** — `pi-assets.json` is the input. SW-context
  GET to the video-URL endpoints is proven; wire the capture flow next.
- **Snapshot size** — `pwCrawlSnapshot` is ~64 MB; restore-on-restart works but is
  heavy. Could store the compact normalized form instead.
- **Tests:** `npx vitest run` (36 passing). Core logic in `test/crawler.test.js`.

## 9. Key file inventory (this session)
| file | purpose |
|------|---------|
| `crawler.js` | active Pi crawler (`PWCrawler`) + pure helpers |
| `background.js` | token capture, crawl lifecycle, compact result handlers, page transport |
| `content_script.js` | MAIN-world API interception (+capture diagnostic) |
| `message_proxy.js` | ISOLATED bridge + `PW_PAGE_FETCH` fetch executor |
| `panel/*` | UI (summary + flat export) |
| `cdp-debug.mjs` | CDP automation toolkit (not part of the extension runtime) |
| `test/crawler.test.js` | unit tests for the crawler core |
| `../crawler-output/*` | normalized catalog outputs + verify.mjs |
