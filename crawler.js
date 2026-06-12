// crawler.js — PW Pi Content Tree Crawler (ES Module)
//
// ── Re-architecture note ────────────────────────────────────────────────────
// The PW Pi content model is NOT batch → subject → chapter → lecture. The real
// hierarchy, derived from the live watch/landing URLs, is:
//
//     category  →  widget (a content shelf)  →  item
//                                                 ├─ single video   (childId)
//                                                 └─ playlist        (playlistId → many childId)
//
// The category-list / category-widgets / widget "view-all" REST endpoints are
// served from an un-captured async chunk and are therefore UNKNOWN. We do NOT
// guess them (guessing them is what produced the previous 401/empty crawls).
//
// Instead this crawler is HARVEST-FIRST: the extension's content script already
// intercepts every `penpencil.co` request and forwards the FULL response body
// (see content_script.js `emitApiCaptured` → background `API_CAPTURED`). As the
// user browses Pi, those captured responses contain the entire category/widget/
// item tree. We reconstruct the tree by parsing the captures — no blind calls,
// no guessed endpoints, immune to the auth/CORS issues that caused the 401s.
//
// Playlists are expanded with the ONE confirmed OTT endpoint
// (`ott/v1/ott/playlist/{playlistId}`). Any active request goes through an
// injectable transport so it can run in the page's authenticated context and so
// the pure logic stays unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Confirmed penpencil OTT endpoints (verified against the player bundle). */
export const OTT_ENDPOINTS = Object.freeze({
  apiBase: 'https://api.penpencil.co',
  category: 'ott/v1/ott/category',
  widget: 'ott/v1/ott/widget',
  widgetContent: 'ott/v1/ott/widget/{widgetId}/content',
  playlist: 'ott/v1/ott/playlist/{playlistId}',
  videoDetails: 'ott/v1/ott/video/details/{childId}',
  userData: 'ott/v1/ott/video/{childId}/user-data',
});

export const CRAWLER_STATES = Object.freeze({
  IDLE: 'idle',
  CRAWLING: 'crawling',
  PAUSED: 'paused',
  ERROR: 'error',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
});

const PI_ROOT = 'https://www.pw.live/study-v2/pi';
const WATCH_BASE = 'https://www.pw.live/watch/';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function log(...a) { console.log('[PW-Crawler]', ...a); }
function warn(...a) { console.warn('[PW-Crawler]', ...a); }

// ─── Pure helpers (exported for unit tests) ──────────────────────────────────

/** First defined value among the given keys of obj. */
export function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return fallback;
}

/**
 * Build a canonical PW watch URL for a lecture.
 * Single video:  /watch/?categoryId=..&widgetId=..&childId=..
 * Playlist item: /watch/?categoryId=..&widgetId=..&playlistId=..&childId=..&default_enabled_feature=PLAYLIST
 */
export function buildWatchUrl({ categoryId, widgetId, playlistId, childId } = {}) {
  const params = new URLSearchParams();
  if (categoryId) params.set('categoryId', categoryId);
  if (widgetId) params.set('widgetId', widgetId);
  if (playlistId) params.set('playlistId', playlistId);
  if (childId) params.set('childId', childId);
  if (playlistId) params.set('default_enabled_feature', 'PLAYLIST');
  return `${WATCH_BASE}?${params.toString()}`;
}

/** Coerce a captured entry's response body to a parsed object (handles JSON strings). */
export function parseBody(body) {
  if (body == null) return null;
  if (typeof body === 'object') return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return null; }
  }
  return null;
}

/** Pull the payload array/object out of PW's `{ success, data }` envelope. */
export function unwrap(body) {
  const parsed = parseBody(body);
  if (parsed == null) return null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'data')) return parsed.data;
  return parsed;
}

/**
 * Classify a raw item object from a widget/playlist/list response into a
 * normalized lecture or playlist node. Returns null if it isn't a content item.
 */
export function classifyItem(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const typeStr = String(pick(raw, ['contentType', 'type']) || '');
  const explicitPlaylist = pick(raw, ['playlistId', 'playlist_id']);
  const isPlaylist = explicitPlaylist !== undefined || /playlist/i.test(typeStr);
  const playlistId = isPlaylist ? (explicitPlaylist || pick(raw, ['_id', 'id'])) : undefined;
  // For a single video the childId is the CONTENT id (`_id`) — that is what the
  // /watch/?childId= URL expects. Do NOT use `videoId`: in playlist payloads
  // (ottVideoDetails[]) each video carries both `_id` (content) and `videoId`
  // (underlying media/stream id); only `_id` is valid for the watch URL.
  const childId = isPlaylist ? undefined : (pick(raw, ['childId', 'child_id']) || pick(raw, ['_id', 'id', 'contentId']));
  const videoId = pick(raw, ['videoId']) || null;

  const title = pick(raw, ['title', 'name', 'topic', 'displayName'], 'Untitled');
  const duration = pick(raw, ['duration', 'videoDuration']) ??
    pick(raw.videoDetails || {}, ['duration']) ?? null;
  const thumbnailUrl = pick(raw, ['imageId', 'thumbnail', 'thumbnailUrl', 'image']) ??
    pick(raw.videoDetails || {}, ['image', 'thumbnail']) ?? null;

  if (playlistId) {
    return {
      itemType: 'playlist',
      playlistId,
      title,
      thumbnailUrl,
      viewUrl: buildWatchUrl({ ...ctx, playlistId }),
      lectures: [], // filled by playlist expansion / harvest
    };
  }
  if (childId) {
    return {
      itemType: 'video',
      childId,
      videoId,
      playlistId: ctx.playlistId || null,
      title,
      duration,
      thumbnailUrl,
      watchUrl: buildWatchUrl({ ...ctx, childId }),
      hasCapturedKey: false,
    };
  }
  return null;
}

/**
 * Recursively scan an arbitrary PW response value, collecting any objects that
 * look like content items (have childId / playlistId / video markers).
 * This tolerance is what lets us harvest items without knowing the exact
 * response schema of the (unknown) widget/category endpoints.
 */
export function collectItems(value, ctx = {}, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const v of value) collectItems(v, ctx, out, seen);
    return out;
  }

  const looksLikeItem =
    pick(value, ['childId', 'playlistId', 'child_id']) !== undefined ||
    (pick(value, ['contentType', 'type']) &&
      /VIDEO|PLAYLIST|OTT/i.test(String(pick(value, ['contentType', 'type'])))) ||
    value.videoDetails !== undefined;

  if (looksLikeItem) {
    const item = classifyItem(value, ctx);
    if (item) out.push(item);
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child && typeof child === 'object') collectItems(child, ctx, out, seen);
  }
  return out;
}

/** Total lecture count across the category → widget → item(/playlist) tree. */
export function flattenLectures(results) {
  const lectures = [];
  if (!results) return lectures;
  for (const cat of results.categories || []) {
    const categoryId = cat.categoryId;
    for (const w of cat.widgets || []) {
      const widgetId = w.widgetId;
      for (const item of w.items || []) {
        if (item.itemType === 'playlist') {
          for (const lec of item.lectures || []) lectures.push(lec);
        } else if (item.itemType === 'video') {
          lectures.push(item);
        }
      }
      // widgets may also carry pre-flattened lectures (harvest fallback)
      for (const lec of w.lectures || []) lectures.push(lec);
      void categoryId; void widgetId;
    }
  }
  return lectures;
}

/**
 * Identify the URL "kind" of a captured PW request so we know how to treat it.
 * Only OTT kinds are recognized by literal path; everything else is "nav"
 * (home/category/widget/view-all) and is harvested generically.
 */
export function classifyCaptureUrl(url) {
  if (!url) return 'unknown';
  try {
    const u = new URL(url, OTT_ENDPOINTS.apiBase);
    const p = u.pathname;
    if (/\/ott\/v1\/ott\/playlist\//.test(p)) return 'playlist';
    if (/\/ott\/v1\/ott\/video\/details\//.test(p)) return 'video-details';
    if (/\/ott\/v1\/ott\/video\/[^/]+\/user-data/.test(p)) return 'user-data';
    if (/video-url-details/.test(p)) return 'video-url';
    if (/video-stats|register-session|sync-stats|save-stats/.test(p)) return 'stats';
    if (u.hostname.includes('penpencil.co')) return 'nav';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Crawler ──────────────────────────────────────────────────────────────────

export class PWCrawler {
  /**
   * @param {Object} options
   * @param {number} [options.delayMs=400]
   * @param {number} [options.maxRetries=3]
   * @param {Function} [options.onProgress]
   * @param {Function} [options.onDebug]
   * @param {Array}    [options.captures] - captured API entries {url, method, responseBody}
   * @param {Function} [options.loadCaptures] - async () => captures[] (preferred over `captures`)
   * @param {Function} [options.transport] - async ({path, params, method, body}) => parsed JSON.
   *                    Should run in the authenticated page context. If omitted,
   *                    a service-worker fetch using stored auth headers is used.
   * @param {Object}   [options.auth] - { token, capturedHeaders } for the default transport.
   */
  constructor(options = {}) {
    this.delayMs = options.delayMs ?? 400;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxPages = options.maxPages ?? 100;
    this.onProgress = options.onProgress || null;
    this.onDebug = options.onDebug || null;
    this.captures = options.captures || null;
    this.loadCaptures = options.loadCaptures || null;
    this.transport = options.transport || null;
    this.auth = options.auth || null;

    this.state = CRAWLER_STATES.IDLE;
    this.abortController = null;
    this._pausePromise = null;
    this._pauseResolve = null;

    this.progress = this._emptyProgress();
    this.results = null;
  }

  _emptyProgress() {
    return {
      totalCategories: 0, crawledCategories: 0,
      totalWidgets: 0, crawledWidgets: 0,
      totalPlaylists: 0, expandedPlaylists: 0,
      totalLectures: 0,
      currentPath: '',
      errors: [],
    };
  }

  // ─── Main entry ─────────────────────────────────────────────────────────────

  /**
   * @param {string} [depth='full'] 'full' expands playlists; 'harvest' parses
   *        captures only (no active requests).
   */
  async crawlPiTree(depth = 'full') {
    if (this.state === CRAWLER_STATES.CRAWLING) {
      throw new Error('Crawl already in progress');
    }
    this.state = CRAWLER_STATES.CRAWLING;
    this.abortController = new AbortController();
    this.progress = this._emptyProgress();
    this.results = {
      crawlId: `pi_${Date.now()}`,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'crawling',
      piRoot: PI_ROOT,
      model: 'category>widget>item',
      categories: [],
    };

    try {
      if (depth === 'harvest') {
        // Parse-only: reconstruct from captured nav traffic, no active requests.
        const captures = await this._getCaptures();
        this._emitDebug('captures_loaded', { count: captures.length });
        if (captures.length === 0) {
          throw new Error(
            'No captured PW API traffic to harvest. Open pw.live/study-v2/pi and ' +
            'browse the categories / "view all" pages with API recording on, then crawl.'
          );
        }
        this._updatePath('Harvesting captured Pi traffic...');
        this.results.categories = this._harvestCategories(captures);
        this._recountTree();
        this._emitProgress();
        this._absorbCapturedPlaylists(captures);
        this._recountTree();
        this._emitProgress();
        return this._complete();
      }

      // Active full crawl over the confirmed Pi endpoints
      // (category -> widget -> widget content -> playlist).
      await this._activeCrawl();
      await this._expandPlaylists();
      return this._complete();
    } catch (err) {
      if (err.message === 'Crawl aborted') {
        this.state = CRAWLER_STATES.STOPPED;
        if (this.results) { this.results.status = 'stopped'; this.results.completedAt = new Date().toISOString(); }
        log('Crawl aborted; partial results preserved.');
      } else {
        this.state = CRAWLER_STATES.ERROR;
        this._addError('crawl', 0, err.message);
        if (this.results) { this.results.status = 'error'; this.results.completedAt = new Date().toISOString(); }
        warn('Crawl failed:', err.message);
      }
      return this.results;
    }
  }

  // ─── Harvest ──────────────────────────────────────────────────────────────

  async _getCaptures() {
    let caps = [];
    if (this.loadCaptures) {
      try { caps = (await this.loadCaptures()) || []; } catch (e) { warn('loadCaptures failed:', e.message); }
    } else if (Array.isArray(this.captures)) {
      caps = this.captures;
    }
    return caps.filter(c => c && c.url);
  }

  /**
   * Build category nodes from captured "nav" responses. Because the exact
   * schema is unknown, we treat each distinct categoryId seen in the captured
   * watch/landing context as a category, and group the harvested items under
   * the widgetId they belong to. Items lacking explicit ids are grouped into a
   * synthetic "unsorted" widget so nothing is dropped.
   */
  _harvestCategories(captures) {
    const categories = new Map(); // categoryId -> { categoryId, categoryName, widgets:Map }

    const ensureCategory = (categoryId, name) => {
      const key = categoryId || '_uncategorized';
      if (!categories.has(key)) {
        categories.set(key, { categoryId: categoryId || null, categoryName: name || 'Pi', widgets: new Map() });
      }
      const c = categories.get(key);
      if (name && (!c.categoryName || c.categoryName === 'Pi')) c.categoryName = name;
      return c;
    };
    const ensureWidget = (cat, widgetId, name, type) => {
      const key = widgetId || '_unsorted';
      if (!cat.widgets.has(key)) {
        cat.widgets.set(key, { widgetId: widgetId || null, widgetName: name || 'Items', widgetType: type || null, items: [], _seen: new Set() });
      }
      const w = cat.widgets.get(key);
      if (name && (!w.widgetName || w.widgetName === 'Items')) w.widgetName = name;
      return w;
    };

    for (const cap of captures) {
      const kind = classifyCaptureUrl(cap.url);
      if (kind !== 'nav') continue;
      const ctxIds = this._urlContext(cap.url);
      const payload = unwrap(cap.responseBody);
      if (payload == null) continue;

      // Try to discover category/widget structure within the payload.
      const structured = this._harvestStructured(payload, ctxIds, ensureCategory, ensureWidget);
      if (!structured) {
        // Fallback: scrape any content items out of the payload and attach to context.
        const cat = ensureCategory(ctxIds.categoryId, ctxIds.categoryName);
        const w = ensureWidget(cat, ctxIds.widgetId, ctxIds.widgetName);
        for (const item of collectItems(payload, ctxIds)) this._addItem(w, item);
      }
    }

    // Materialize maps → arrays.
    return Array.from(categories.values()).map(c => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      widgets: Array.from(c.widgets.values()).map(w => ({
        widgetId: w.widgetId,
        widgetName: w.widgetName,
        widgetType: w.widgetType,
        items: w.items,
      })),
    }));
  }

  /**
   * Recognize explicit category/widget containers in a payload. Returns true if
   * a recognizable structure was consumed, false to let the caller fall back.
   */
  _harvestStructured(payload, ctxIds, ensureCategory, ensureWidget) {
    const arr = Array.isArray(payload) ? payload : (Array.isArray(payload?.widgets) ? payload.widgets : null);
    if (!arr) return false;

    let consumed = false;
    for (const node of arr) {
      if (!node || typeof node !== 'object') continue;
      const widgetId = pick(node, ['widgetId', '_id', 'id']);
      const widgetName = pick(node, ['title', 'name', 'displayName']);
      const widgetType = pick(node, ['widgetType', 'type', 'contentType']);
      const inner = node.data || node.items || node.contents || node.children || node;
      const items = collectItems(inner, { ...ctxIds, widgetId });
      if (items.length === 0) continue;
      const cat = ensureCategory(ctxIds.categoryId, ctxIds.categoryName);
      const w = ensureWidget(cat, widgetId || ctxIds.widgetId, widgetName || ctxIds.widgetName, widgetType);
      for (const it of items) this._addItem(w, it);
      consumed = true;
    }
    return consumed;
  }

  _addItem(widget, item) {
    if (!item) return;
    const sig = item.itemType === 'playlist' ? `p:${item.playlistId}` : `v:${item.childId}`;
    if (widget._seen.has(sig)) {
      // Merge playlist lectures if a later capture has more.
      if (item.itemType === 'playlist' && item.lectures?.length) {
        const existing = widget.items.find(i => i.itemType === 'playlist' && i.playlistId === item.playlistId);
        if (existing && item.lectures.length > (existing.lectures?.length || 0)) existing.lectures = item.lectures;
      }
      return;
    }
    widget._seen.add(sig);
    widget.items.push(item);
  }

  /** Extract categoryId/widgetId/playlistId/childId from a captured request URL. */
  _urlContext(url) {
    const out = { categoryId: null, widgetId: null, playlistId: null, childId: null, categoryName: null, widgetName: null };
    try {
      const u = new URL(url, OTT_ENDPOINTS.apiBase);
      for (const k of Object.keys(out)) {
        const v = u.searchParams.get(k);
        if (v) out[k] = v;
      }
    } catch { /* ignore */ }
    return out;
  }

  /** Seed playlist.lectures from any captured `ott/v1/ott/playlist/{id}` responses. */
  _absorbCapturedPlaylists(captures) {
    const byId = new Map();
    for (const cap of captures) {
      if (classifyCaptureUrl(cap.url) !== 'playlist') continue;
      const m = String(cap.url).match(/\/ott\/v1\/ott\/playlist\/([^/?#]+)/);
      if (!m) continue;
      const payload = unwrap(cap.responseBody);
      const lectures = collectItems(payload, { playlistId: m[1] })
        .filter(i => i.itemType === 'video');
      if (lectures.length) byId.set(m[1], lectures);
    }
    if (byId.size === 0) return;
    for (const lec of this._eachPlaylist()) {
      const found = byId.get(lec.playlistId);
      if (found && found.length > (lec.lectures?.length || 0)) {
        lec.lectures = found.map(v => ({ ...v, playlistId: lec.playlistId, watchUrl: buildWatchUrl({ ...lec._ctx, playlistId: lec.playlistId, childId: v.childId }) }));
      }
    }
  }

  /** Yield every playlist item in the tree with its category/widget context. */
  *_eachPlaylist() {
    for (const cat of this.results.categories || []) {
      for (const w of cat.widgets || []) {
        for (const item of w.items || []) {
          if (item.itemType === 'playlist') {
            item._ctx = { categoryId: cat.categoryId, widgetId: w.widgetId };
            yield item;
          }
        }
      }
    }
  }

  // ─── Active full crawl (confirmed Pi endpoints) ────────────────────────────

  /**
   * Enumerate the entire Pi tree via the confirmed REST endpoints:
   *   category  → widget?categoryId  → widget/{id}/content?categoryId&page
   * Items are classified into single videos / playlists; playlists are filled
   * later by _expandPlaylists. De-duplicates items within a widget.
   */
  async _activeCrawl() {
    this._updatePath('Discovering categories...');
    const rootResp = await this._request(OTT_ENDPOINTS.category);
    const roots = (unwrap(rootResp) || []).filter(c => c && (c._id || c.id));

    // The category endpoint returns only ROOT categories; children (which carry
    // the widgets/content) are fetched via ?parentId=. BFS the whole tree,
    // de-duplicating (relatedCategories can cross-link).
    const visited = new Set();
    const categories = [];
    const queue = [...roots];
    while (queue.length) {
      if (this.abortController.signal.aborted) throw new Error('Crawl aborted');
      await this._checkPause();
      const cat = queue.shift();
      const id = cat._id || cat.id;
      if (!id || visited.has(id)) continue;
      visited.add(id);
      categories.push(cat);
      if ((cat.childCount || 0) > 0) {
        try {
          const childResp = await this._request(OTT_ENDPOINTS.category, { parentId: id });
          for (const ch of (unwrap(childResp) || [])) {
            if (ch && (ch._id || ch.id) && !visited.has(ch._id || ch.id)) queue.push(ch);
          }
        } catch (err) {
          if (err.statusCode === 401 || err.message === 'Crawl aborted') throw err;
          warn(`Children of ${pick(cat, ['name'], id)} failed:`, err.message);
        }
        this._updatePath(`Discovering categories... (${categories.length})`);
        this._emitProgress();
        await delay(this.delayMs);
      }
    }
    this.progress.totalCategories = categories.length;
    this._emitProgress();

    for (const cat of categories) {
      if (this.abortController.signal.aborted) throw new Error('Crawl aborted');
      await this._checkPause();
      const categoryId = cat._id || cat.id;
      const categoryName = pick(cat, ['name', 'title'], categoryId);
      this._updatePath(categoryName);
      const catNode = { categoryId, categoryName, widgets: [] };

      let widgets = [];
      try {
        const wResp = await this._request(OTT_ENDPOINTS.widget, { categoryId, landingPage: 'HOME' });
        widgets = (unwrap(wResp) || []).filter(w => w && (w._id || w.id));
      } catch (err) {
        if (err.statusCode === 401 || err.message === 'Crawl aborted') throw err;
        warn(`Widgets for category ${categoryName} failed:`, err.message);
      }
      this.progress.totalWidgets += widgets.length;
      this._emitProgress();

      for (const w of widgets) {
        if (this.abortController.signal.aborted) throw new Error('Crawl aborted');
        await this._checkPause();
        const widgetId = w._id || w.id;
        const widgetNode = {
          widgetId,
          widgetName: pick(w, ['title', 'name'], widgetId),
          widgetType: pick(w, ['type', 'widgetType']) || null,
          items: [],
        };
        this._updatePath(`${categoryName} › ${widgetNode.widgetName}`);
        const ctx = { categoryId, widgetId };
        const seen = new Set();
        const contentPath = OTT_ENDPOINTS.widgetContent.replace('{widgetId}', widgetId);

        let page = 1;
        while (page <= this.maxPages) {
          if (this.abortController.signal.aborted) throw new Error('Crawl aborted');
          await this._checkPause();
          let cResp;
          try {
            cResp = await this._request(contentPath, { categoryId, page });
          } catch (err) {
            if (err.statusCode === 401 || err.message === 'Crawl aborted') throw err;
            warn(`Content for widget ${widgetNode.widgetName} p${page} failed:`, err.message);
            break;
          }
          const data = unwrap(cResp);
          const items = Array.isArray(data) ? data : [];
          for (const raw of items) {
            const item = classifyItem(raw, ctx);
            if (!item) continue;
            const sig = item.itemType === 'playlist' ? `p:${item.playlistId}` : `v:${item.childId}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            widgetNode.items.push(item);
          }
          const totalPending = (parseBody(cResp)?.paginate?.totalPending);
          if (items.length === 0) break;
          if (typeof totalPending === 'number' && totalPending <= 0) break;
          page++;
          await delay(this.delayMs);
        }

        catNode.widgets.push(widgetNode);
        this.progress.crawledWidgets++;
        this._recountTree();
        this._emitProgress();
        await delay(this.delayMs);
      }

      this.results.categories.push(catNode);
      this.progress.crawledCategories++;
      this._recountTree();
      this._emitProgress();
    }
  }

  // ─── Active playlist expansion (confirmed endpoint only) ────────────────────

  async _expandPlaylists() {
    const all = [...this._eachPlaylist()];
    this.progress.totalPlaylists = all.length;
    this._emitProgress();
    // The same playlist appears across many shelves/categories. Fetch each
    // unique playlistId ONCE, then assign its lectures to every occurrence
    // (re-pointing watch URLs to that occurrence's category/widget context).
    const uniqueIds = [...new Set(all.map(p => p.playlistId).filter(Boolean))];
    const byId = new Map();
    let done = 0;
    for (const pid of uniqueIds) {
      if (this.abortController.signal.aborted) throw new Error('Crawl aborted');
      await this._checkPause();
      const sample = all.find(p => p.playlistId === pid);
      this._updatePath(`Playlist ${sample?.title || pid} (${done + 1}/${uniqueIds.length})`);
      try {
        const json = await this._request(OTT_ENDPOINTS.playlist.replace('{playlistId}', pid));
        const ctx = { ...(sample?._ctx || {}), playlistId: pid };
        const data = unwrap(json);
        const lectures = Array.isArray(data)
          ? data.map(raw => classifyItem(raw, ctx)).filter(i => i && i.itemType === 'video')
          : collectItems(data, ctx).filter(i => i.itemType === 'video');
        byId.set(pid, lectures);
      } catch (err) {
        if (err.statusCode === 401 || err.message === 'Crawl aborted') throw err;
        warn(`Playlist ${pid} expansion failed:`, err.message);
        byId.set(pid, []);
      }
      done++;
      this.progress.expandedPlaylists = done;
      if (done % 10 === 0) { this._recountTree(); this._emitProgress(); }
      await delay(this.delayMs);
    }
    // Assign lectures to every playlist occurrence with its own watch context.
    for (const pl of all) {
      const base = byId.get(pl.playlistId) || [];
      const ctx = { ...(pl._ctx || {}), playlistId: pl.playlistId };
      pl.lectures = base.map(v => ({ ...v, playlistId: pl.playlistId, watchUrl: buildWatchUrl({ ...ctx, childId: v.childId }) }));
    }
    this._recountTree();
    this._emitProgress();
  }

  // ─── Transport ──────────────────────────────────────────────────────────────

  /** Perform an authenticated GET, retrying transient failures. */
  async _request(path, params = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (this.abortController?.signal.aborted) throw new Error('Crawl aborted');
      await this._checkPause();
      this._emitDebug('request', { path, attempt, params });
      try {
        const json = this.transport
          ? await this.transport({ path, params, method: 'GET' })
          : await this._defaultTransport({ path, params, method: 'GET' });
        this._emitDebug('response', { path, ok: true });
        return json;
      } catch (err) {
        lastErr = err;
        if (err.statusCode === 401) {
          err.message = `Auth rejected (401) on ${path}. Refresh the PW tab so a new token is captured. ${err.message || ''}`;
          this._addError(path, 401, err.message);
          throw err;
        }
        // 4xx client errors (e.g. 404 "no widgets/content for this category")
        // are expected for some categories and not retryable — surface them to
        // the caller without retrying or spamming the error log.
        if (err.statusCode >= 400 && err.statusCode < 500) {
          this._emitDebug('response', { path, ok: false, status: err.statusCode });
          throw err;
        }
        this._emitDebug('response', { path, ok: false, error: err.message });
        if (attempt < this.maxRetries) await delay(Math.pow(2, attempt - 1) * 1000);
      }
    }
    this._addError(path, 0, lastErr?.message || 'unknown');
    throw lastErr || new Error(`Failed: ${path}`);
  }

  /** Default service-worker fetch transport (used when no page transport given). */
  async _defaultTransport({ path, params }) {
    if (typeof fetch !== 'function') throw new Error('No fetch available and no transport injected');
    const url = new URL(path, OTT_ENDPOINTS.apiBase);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers = { Accept: 'application/json', ...(this.auth?.capturedHeaders || {}) };
    if (this.auth?.token) headers.Authorization = `Bearer ${this.auth.token}`;
    const resp = await fetch(url.toString(), { method: 'GET', headers });
    if (resp.status === 401) { const e = new Error('401'); e.statusCode = 401; throw e; }
    if (!resp.ok) { const e = new Error(`HTTP ${resp.status}`); e.statusCode = resp.status; throw e; }
    return resp.json();
  }

  // ─── Pause / resume / stop ──────────────────────────────────────────────────

  pause() {
    if (this.state !== CRAWLER_STATES.CRAWLING) return;
    this.state = CRAWLER_STATES.PAUSED;
    this._pausePromise = new Promise(res => { this._pauseResolve = res; });
    this._emitProgress();
  }
  resume() {
    if (this.state !== CRAWLER_STATES.PAUSED) return;
    this.state = CRAWLER_STATES.CRAWLING;
    this._pauseResolve?.();
    this._pauseResolve = this._pausePromise = null;
    this._emitProgress();
  }
  stop() {
    if (this.state === CRAWLER_STATES.IDLE || this.state === CRAWLER_STATES.COMPLETED) return;
    this._pauseResolve?.();
    this._pauseResolve = this._pausePromise = null;
    this.abortController?.abort();
    this.state = CRAWLER_STATES.STOPPED;
    if (this.results) { this.results.status = 'stopped'; this.results.completedAt = new Date().toISOString(); }
    this._emitProgress();
  }

  // ─── State ────────────────────────────────────────────────────────────────

  getState() { return { state: this.state, progress: { ...this.progress } }; }
  getProgress() { return { ...this.progress }; }
  getResults() { return this.results; }

  async _checkPause() { if (this.state === CRAWLER_STATES.PAUSED && this._pausePromise) await this._pausePromise; }

  _complete() {
    this.state = CRAWLER_STATES.COMPLETED;
    this.results.status = 'completed';
    this.results.completedAt = new Date().toISOString();
    this._recountTree();
    this._emitProgress();
    log('Crawl complete:', JSON.stringify({ categories: this.progress.totalCategories, lectures: this.progress.totalLectures }));
    return this.results;
  }

  _recountTree() {
    const cats = this.results?.categories || [];
    this.progress.totalCategories = Math.max(this.progress.totalCategories || 0, cats.length);
    this.progress.crawledCategories = cats.length;
    let widgets = 0, playlists = 0;
    for (const c of cats) {
      widgets += (c.widgets || []).length;
      for (const w of c.widgets || []) {
        for (const it of w.items || []) if (it.itemType === 'playlist') playlists++;
      }
    }
    this.progress.totalWidgets = widgets;
    this.progress.crawledWidgets = widgets;
    this.progress.totalPlaylists = playlists;
    this.progress.totalLectures = flattenLectures(this.results).length;
  }

  _addError(scope, statusCode, message) {
    this.progress.errors.push({ scope, statusCode, message, timestamp: new Date().toISOString() });
  }
  _updatePath(p) { this.progress.currentPath = p; }
  _emitProgress() { if (this.onProgress) { try { this.onProgress({ state: this.state, progress: { ...this.progress } }); } catch {} } }
  _emitDebug(type, data = {}) { if (this.onDebug) { try { this.onDebug(type, data); } catch {} } }

  // ─── Persistence ────────────────────────────────────────────────────────────

  serializeState() {
    if (!this.results) return null;
    return { state: this.state, results: this.results, progress: { ...this.progress }, delayMs: this.delayMs, serializedAt: Date.now() };
  }
  restoreState(saved) {
    if (!saved || !saved.results) return false;
    this.results = saved.results;
    this.progress = { ...this._emptyProgress(), ...(saved.progress || {}) };
    this.progress.errors = saved.progress?.errors || [];
    this.delayMs = saved.delayMs || this.delayMs;
    this.state = CRAWLER_STATES.STOPPED;
    return true;
  }
}

export default PWCrawler;
