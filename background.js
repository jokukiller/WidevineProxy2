import "./lib/protobuf.min.js";
import "./lib/license_protocol.min.js";
const { LicenseType, SignedMessage, LicenseRequest, License } = protobuf.roots.default.license_protocol;

import "./lib/forge.min.js";

import { Session } from "./lib/cdm.js";
import { DeviceManager, SettingsManager, AsyncLocalStorage, RemoteCDMManager, IconManager, Util } from "./lib/util.js";
import { WidevineDevice } from "./lib/device.js";
import { RemoteCdm } from "./lib/remote_cdm.js";
import { PWCrawler, flattenLectures } from "./crawler.js";


let manifests = new Map();
let requests = new Map();
let sessions = new Map();
let videoTitles = new Map();
let classTitles = new Map();
let logs = [];
const DEBUG_ENABLED_KEY = "__wvp2_debug_enabled";
const DEBUG_EVENTS_KEY = "__wvp2_debug_events";
const DEBUG_MAX_EVENTS = 500;

// === PW API CRAWLER: State ===
let capturedApis = new Map();
let apiRecordingEnabled = true;
let pwCrawler = null;
let crawlSnapshotTimer = null;

// ─── Crawler Debug Console ────────────────────────────────────────────────
const CRAWL_DEBUG_MAX = 300;
let crawlDebugEvents = [];
const CRAWL_API_LOG_MAX = 500;
let crawlApiLog = []; // Full-detail API capture log for debug dump

function crawlDebug(type, data = {}) {
    const entry = {
        ts: Date.now(),
        time: new Date().toISOString().slice(11, 23), // HH:MM:SS.mmm
        type,
        ...data,
    };
    crawlDebugEvents.push(entry);
    if (crawlDebugEvents.length > CRAWL_DEBUG_MAX) {
        crawlDebugEvents = crawlDebugEvents.slice(-CRAWL_DEBUG_MAX);
    }
    // Broadcast to any open panel
    try {
        chrome.runtime.sendMessage({ type: 'CRAWL_DEBUG_EVENT', entry }).catch(() => {});
    } catch {}
}

async function updateAuthToken(headers) {
    if (!headers) {
        crawlDebug('token_skipped', { reason: 'no_request_headers' });
        return;
    }
    let authValue = null;
    for (const [key, value] of Object.entries(headers)) {
        // Only accept a real PW API bearer JWT ("Bearer eyJ..."). This rejects
        // unrelated Authorization headers on penpencil.co subdomains — notably
        // Unleash feature-flag client keys ("*:production....").
        if (key.toLowerCase() === 'authorization' && typeof value === 'string' && /^Bearer\s+eyJ/.test(value)) {
            authValue = value;
            break;
        }
    }
    if (!authValue) {
        const authPreviews = Object.entries(headers)
            .filter(([k]) => k.toLowerCase() === 'authorization')
            .map(([, v]) => String(v).slice(0, 12));
        crawlDebug('token_skipped', {
            reason: authPreviews.length ? 'non_jwt_authorization' : 'no_authorization_header',
            headerKeys: Object.keys(headers),
            authPreviews,
        });
        if (authPreviews.length) {
            console.warn('[PW-Crawler] Ignored non-JWT Authorization header:', authPreviews);
        }
        return;
    }
    const token = authValue.slice(7).trim();
    if (!token) {
        crawlDebug('token_skipped', { reason: 'empty_token_value' });
        return;
    }

    // Build a sanitized header template — keep PW-specific headers, drop browser-managed ones
    const SKIP_HEADERS = new Set([
        'authorization', 'host', 'connection', 'content-length',
        'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode',
        'sec-fetch-site', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
        'cookie', 'accept-encoding', 'user-agent',
    ]);
    const capturedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!SKIP_HEADERS.has(key.toLowerCase()) && !key.toLowerCase().startsWith('sec-')) {
            capturedHeaders[key] = value;
        }
    }
    // Always ensure these are present with sensible defaults
    if (!capturedHeaders['Client-Service'] && !capturedHeaders['client-service']) {
        capturedHeaders['Client-Service'] = 'frontend';
    }
    if (!capturedHeaders['app-version'] && !capturedHeaders['App-Version']) {
        capturedHeaders['app-version'] = '5.1.2';
    }

    const stored = await chrome.storage.local.get('pwAuthToken');
    const existingToken = stored.pwAuthToken?.token;
    const existingHeaders = stored.pwAuthToken?.capturedHeaders;

    // Update if token changed OR headers changed
    if (existingToken === token && JSON.stringify(existingHeaders) === JSON.stringify(capturedHeaders)) return;

    await chrome.storage.local.set({
        pwAuthToken: {
            token,
            capturedAt: Date.now(),
            expiresAt: null,
            capturedHeaders,
        }
    });
    console.log('[PW-Crawler] Auth token + headers captured:', Object.keys(capturedHeaders).join(', '));
    crawlDebug('token_captured', {
        tokenPreview: token.substring(0, 20) + '...',
        headerKeys: Object.keys(capturedHeaders),
        headerCount: Object.keys(capturedHeaders).length,
    });
}

async function saveCrawlSnapshot() {
    if (!pwCrawler) return;
    const snapshot = pwCrawler.serializeState();
    if (!snapshot) return;
    try {
        await chrome.storage.local.set({ pwCrawlSnapshot: snapshot });
    } catch (e) {
        console.warn('[PW-Crawler] Failed to save snapshot:', e.message);
    }
}

function countLectures(results) {
    return flattenLectures(results).length;
}

/**
 * Deduplicate the (heavily cross-listed) lecture tree by childId into a compact
 * flat catalog suitable for messaging/export. The full tree can exceed the
 * 64 MiB runtime-message limit at Pi scale; this stays small.
 */
function getFlatCatalog(results) {
    const seen = new Set();
    const flat = [];
    for (const lec of flattenLectures(results)) {
        const id = lec.childId || lec.watchUrl;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        flat.push({
            childId: lec.childId || null,
            playlistId: lec.playlistId || null,
            title: lec.title || null,
            duration: lec.duration || null,
            watchUrl: lec.watchUrl,
            hasCapturedKey: !!lec.hasCapturedKey,
        });
    }
    return flat;
}

/** Small structural summary (counts only) for the panel — never the full tree. */
function getCrawlSummary(results) {
    if (!results) return null;
    const cats = results.categories || [];
    let widgets = 0, playlists = 0, items = 0;
    const categories = cats.map(c => {
        let cw = 0, ci = 0;
        for (const w of (c.widgets || [])) { cw++; widgets++; ci += (w.items || []).length; items += (w.items || []).length; for (const it of (w.items || [])) if (it.itemType === 'playlist') playlists++; }
        return { categoryId: c.categoryId, categoryName: c.categoryName, widgets: cw, items: ci };
    });
    return {
        crawlId: results.crawlId,
        status: results.status,
        startedAt: results.startedAt,
        completedAt: results.completedAt,
        categoryCount: cats.length,
        widgetCount: widgets,
        playlistCount: playlists,
        itemCount: items,
        uniqueLectureCount: getFlatCatalog(results).length,
        categories,
    };
}

async function saveCrawlToHistory(results) {
    if (!results) return;
    try {
        const stored = await chrome.storage.local.get('pwCrawlHistory');
        const history = Array.isArray(stored.pwCrawlHistory) ? stored.pwCrawlHistory : [];
        const capturedKeyUrls = new Set();
        const allLogs = await AsyncLocalStorage.getStorage(null);
        for (const [, logEntry] of Object.entries(allLogs)) {
            if (logEntry?.url) capturedKeyUrls.add(logEntry.url);
        }
        let keysMatched = 0;
        for (const lecture of flattenLectures(results)) {
            lecture.hasCapturedKey = capturedKeyUrls.has(lecture.watchUrl);
            if (lecture.hasCapturedKey) keysMatched++;
        }
        const entry = {
            crawlId: results.crawlId,
            startedAt: results.startedAt,
            completedAt: results.completedAt || new Date().toISOString(),
            status: results.status || 'unknown',
            categoryCount: results.categories ? results.categories.length : 0,
            lectureCount: getFlatCatalog(results).length,
            keysMatched,
            // NOTE: the full result tree is intentionally NOT stored here — at Pi
            // scale it exceeds the runtime-message limit. The current session's
            // results live in memory + pwCrawlSnapshot for export; history is a
            // lightweight log of past runs.
        };
        history.unshift(entry);
        if (history.length > 20) history.length = 20;
        await chrome.storage.local.set({ pwCrawlHistory: history });
        await chrome.storage.local.set({ pwCrawlSnapshot: pwCrawler.serializeState() });
    } catch (e) {
        console.warn('[PW-Crawler] Failed to save history:', e.message);
    }
}

function startSnapshotTimer() {
    stopSnapshotTimer();
    crawlSnapshotTimer = setInterval(() => { saveCrawlSnapshot(); }, 10000);
}

function stopSnapshotTimer() {
    if (crawlSnapshotTimer) {
        clearInterval(crawlSnapshotTimer);
        crawlSnapshotTimer = null;
    }
}

// ─── Page-context request transport for the crawler ─────────────────────────
// Runs API requests inside an open pw.live tab (page origin) instead of the
// service worker, so playlist expansion authenticates exactly like PW's own
// app and avoids the cross-origin/token 401s that broke the previous crawler.

async function findPwTab() {
    try {
        const active = await getActiveTab();
        if (active && /(^|\.)pw\.live|penpencil\.co/.test(active.url || '')) return active;
    } catch {}
    try {
        const tabs = await chrome.tabs.query({ url: ['*://pw.live/*', '*://*.pw.live/*'] });
        if (tabs && tabs.length) return tabs[0];
    } catch {}
    return null;
}

async function pwPageFetch({ path, params, method = 'GET' }) {
    const url = new URL(path, 'https://api.penpencil.co');
    for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const stored = (await chrome.storage.local.get('pwAuthToken')).pwAuthToken || null;
    const headers = { Accept: 'application/json', ...(stored?.capturedHeaders || {}) };
    if (stored?.token) headers.Authorization = `Bearer ${stored.token}`;

    const tab = await findPwTab();
    if (!tab) {
        const e = new Error('No open pw.live tab to run the request in. Open a PW tab (and stay logged in), then retry.');
        e.statusCode = 0;
        throw e;
    }

    let res;
    try {
        res = await chrome.tabs.sendMessage(
            tab.id,
            { type: 'PW_PAGE_FETCH', payload: { url: url.toString(), method, headers } },
            { frameId: 0 }
        );
    } catch (e) {
        const err = new Error(`Page fetch bridge unavailable on the PW tab: ${e.message}. Reload the PW tab.`);
        err.statusCode = 0;
        throw err;
    }
    if (!res) { const e = new Error('No response from the page fetch bridge'); e.statusCode = 0; throw e; }
    if (res.error) { const e = new Error(res.error); e.statusCode = res.status || 0; throw e; }
    if (res.status === 401) { const e = new Error('Auth rejected (401)'); e.statusCode = 401; throw e; }
    if (res.status === 403) { const e = new Error('Forbidden (403) — not in your subscription'); e.statusCode = 403; throw e; }
    if (res.status >= 400) { const e = new Error(`HTTP ${res.status}`); e.statusCode = res.status; throw e; }
    return res.body;
}

async function restoreLastCrawlState() {
    try {
        const stored = await chrome.storage.local.get('pwCrawlSnapshot');
        if (stored.pwCrawlSnapshot) {
            pwCrawler = new PWCrawler({
                transport: pwPageFetch,
                onProgress: (info) => {
                    chrome.runtime.sendMessage({ type: 'CRAWL_PROGRESS', ...info }).catch(() => {});
                },
            });
            pwCrawler.restoreState(stored.pwCrawlSnapshot);
            console.log('[PW-Crawler] Restored last crawl state from storage');
        }
    } catch (e) {
        console.warn('[PW-Crawler] Failed to restore state:', e.message);
    }
}

restoreLastCrawlState();
// === END PW API CRAWLER: State ===

chrome.webRequest.onBeforeSendHeaders.addListener(
    function(details) {
        if (details.method === "GET") {
            if (!requests.has(details.url)) {
                const headers = details.requestHeaders
                    .filter(item => !(
                        item.name.startsWith('sec-ch-ua') ||
                        item.name.startsWith('Sec-Fetch') ||
                        item.name.startsWith('Accept-') ||
                        item.name.startsWith('Host') ||
                        item.name === "Connection"
                    )).reduce((acc, item) => {
                        acc[item.name] = item.value;
                        return acc;
                    }, {});
                requests.set(details.url, headers);
            }
        }
    },
    {urls: ["<all_urls>"]},
    ['requestHeaders', chrome.webRequest.OnSendHeadersOptions.EXTRA_HEADERS].filter(Boolean)
);

function getMessageVideoTitle(metadata) {
    const title = metadata?.video_title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
}

function getMessageClassTitle(metadata) {
    const title = metadata?.class_title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
}

async function isDebugEnabled() {
    const result = await chrome.storage.local.get(DEBUG_ENABLED_KEY);
    return result[DEBUG_ENABLED_KEY] === true;
}

async function setDebugMode(enabled) {
    await chrome.storage.local.set({[DEBUG_ENABLED_KEY]: enabled === true});
}

async function getDebugEvents() {
    const result = await chrome.storage.local.get(DEBUG_EVENTS_KEY);
    return Array.isArray(result[DEBUG_EVENTS_KEY]) ? result[DEBUG_EVENTS_KEY] : [];
}

async function recordDebugEvent(type, detail = {}, senderContext = {}) {
    if (!await isDebugEnabled()) {
        return false;
    }

    const events = await getDebugEvents();
    events.push({
        timestamp: new Date().toISOString(),
        type,
        tab_id: senderContext.tab_id ?? null,
        tab_url: senderContext.tab_url ?? null,
        detail,
    });

    await chrome.storage.local.set({
        [DEBUG_EVENTS_KEY]: events.slice(-DEBUG_MAX_EVENTS),
    });
    return true;
}

async function clearDebugEvents() {
    await chrome.storage.local.set({[DEBUG_EVENTS_KEY]: []});
}

function rememberVideoTitle(tab_url, metadata) {
    const title = getMessageVideoTitle(metadata);
    if (tab_url && title) {
        videoTitles.set(tab_url, title);
    }

    return title || (tab_url && videoTitles.has(tab_url) ? videoTitles.get(tab_url) : null);
}

function rememberClassTitle(tab_id, metadata) {
    const previousTitle = tab_id != null && classTitles.has(tab_id) ? classTitles.get(tab_id) : null;
    let nextTitle = null;

    if (metadata && Object.prototype.hasOwnProperty.call(metadata, "class_title")) {
        const title = getMessageClassTitle(metadata);
        if (tab_id != null && title) {
            classTitles.set(tab_id, title);
        } else if (tab_id != null) {
            classTitles.delete(tab_id);
        }

        nextTitle = title;
    } else {
        const title = getMessageClassTitle(metadata);
        if (tab_id != null && title) {
            classTitles.set(tab_id, title);
        }

        nextTitle = title || (tab_id != null && classTitles.has(tab_id) ? classTitles.get(tab_id) : null);
    }

    if (metadata) {
        void recordDebugEvent("background_class_memory", {
            metadata_has_class_title: Object.prototype.hasOwnProperty.call(metadata, "class_title"),
            metadata_class_title: metadata?.class_title ?? null,
            previous_class_title: previousTitle,
            next_class_title: nextTitle,
        }, {tab_id});
    }

    return nextTitle;
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    return tabs[0] ?? null;
}

function getHomeUrlSignature(tab_url) {
    try {
        const url = new URL(tab_url);
        return {
            origin: url.origin,
            pathname: url.pathname,
            categoryId: url.searchParams.get("categoryId"),
        };
    } catch {
        return null;
    }
}

async function setHomeUrlTrigger(tab_id = null, tab_url = null) {
    const activeTab = tab_id == null ? await getActiveTab() : null;
    const targetTabId = tab_id ?? activeTab?.id ?? null;
    const targetTabUrl = tab_url ?? activeTab?.url ?? null;
    const signature = getHomeUrlSignature(targetTabUrl);

    if (targetTabId == null || !signature) {
        return false;
    }

    try {
        await chrome.tabs.sendMessage(targetTabId, {
            type: "SET_HOME_URL_TRIGGER",
            payload: {
                signature,
            },
        });
        await recordDebugEvent("home_url_set", {
            signature,
        }, {tab_id: targetTabId, tab_url: targetTabUrl});
        return true;
    } catch (err) {
        console.debug("[WidevineProxy2]", "SET_HOME_URL_TRIGGER_FAILED", err);
        return false;
    }
}

function isSameWatchEntry(log_url, tab_url) {
    if (!log_url || !tab_url || log_url === tab_url) {
        return log_url === tab_url;
    }

    try {
        const logUrl = new URL(log_url);
        const tabUrl = new URL(tab_url);
        const logChildId = logUrl.searchParams.get("childId");
        const tabChildId = tabUrl.searchParams.get("childId");

        if (logChildId && tabChildId) {
            return logUrl.origin === tabUrl.origin &&
                logUrl.pathname === tabUrl.pathname &&
                logChildId === tabChildId;
        }

        return logUrl.origin === tabUrl.origin && logUrl.pathname === tabUrl.pathname;
    } catch {
        return false;
    }
}

function normalizeDuplicateText(value) {
    return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function getMetadataDuplicateKey(class_title, video_title) {
    const normalizedClass = normalizeDuplicateText(class_title);
    const normalizedVideo = normalizeDuplicateText(video_title);
    return normalizedClass && normalizedVideo ? `${normalizedClass}::${normalizedVideo}` : null;
}

function getLogMetadataDuplicateKey(log) {
    return getMetadataDuplicateKey(log?.class_title, log?.video_title);
}

async function getStoredLogsInOrder() {
    const storedLogs = await AsyncLocalStorage.getStorage(null);

    return Object.values(storedLogs)
        .filter(log => log?.pssh_data)
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
}

async function getSavedLogsInOrder() {
    if (logs.length > 0) {
        return logs;
    }

    return await getStoredLogsInOrder();
}

function isMetadataDuplicateLog(log, previousLog) {
    const logKey = getLogMetadataDuplicateKey(log);
    const previousLogKey = getLogMetadataDuplicateKey(previousLog);
    return Boolean(logKey && previousLogKey && logKey === previousLogKey);
}

async function notifyDuplicate(tab_id, duplicateLog) {
    if (!tab_id || !duplicateLog) {
        return;
    }

    try {
        await chrome.tabs.sendMessage(tab_id, {
            type: "DUPLICATE_NOTIFICATION",
            payload: {
                class_title: duplicateLog.class_title ?? null,
                video_title: duplicateLog.video_title ?? null,
            },
        });
    } catch (err) {
        console.debug("[WidevineProxy2]", "DUPLICATE_NOTIFICATION_FAILED", err);
    }
}

async function removeLog(log) {
    const index = logs.lastIndexOf(log);
    if (index >= 0) {
        logs.splice(index, 1);
    } else {
        const matchingIndex = logs.map(entry => entry.pssh_data).lastIndexOf(log.pssh_data);
        if (matchingIndex >= 0) {
            logs.splice(matchingIndex, 1);
        }
    }

    const replacementLog = logs.slice().reverse().find(entry => entry.pssh_data === log.pssh_data);
    if (replacementLog) {
        await AsyncLocalStorage.setStorage({[replacementLog.pssh_data]: replacementLog});
    } else {
        await chrome.storage.local.remove(log.pssh_data);
    }
}

async function pruneLatestDuplicate(tab_id, changedLogs = []) {
    const savedLogs = await getSavedLogsInOrder();
    if (savedLogs.length < 2) {
        return false;
    }

    const latestLog = savedLogs[savedLogs.length - 1];
    const previousLog = savedLogs[savedLogs.length - 2];

    if (changedLogs.length > 0 && !changedLogs.includes(latestLog)) {
        return false;
    }

    if (!isMetadataDuplicateLog(latestLog, previousLog)) {
        return false;
    }

    await removeLog(latestLog);
    await notifyDuplicate(tab_id, previousLog);
    return true;
}

async function saveCapturedLog(log, tab_id) {
    const savedLogs = await getSavedLogsInOrder();
    const lastLog = savedLogs[savedLogs.length - 1];

    if (isMetadataDuplicateLog(log, lastLog)) {
        await recordDebugEvent("duplicate_skipped", {
            class_title: log.class_title ?? null,
            video_title: log.video_title ?? null,
            duplicate_of_class_title: lastLog?.class_title ?? null,
            duplicate_of_video_title: lastLog?.video_title ?? null,
        }, {tab_id, tab_url: log.url});
        await notifyDuplicate(tab_id, lastLog);
        return false;
    }

    logs.push(log);
    await AsyncLocalStorage.setStorage({[log.pssh_data]: log});
    await recordDebugEvent("log_saved", {
        type: log.type,
        url: log.url,
        class_title: log.class_title ?? null,
        video_title: log.video_title ?? null,
        pssh_data_present: Boolean(log.pssh_data),
        manifest_count: Array.isArray(log.manifests) ? log.manifests.length : 0,
    }, {tab_id, tab_url: log.url});
    IconManager.setNotificationIcon();
    return true;
}

async function updateStoredLogVideoTitles(tab_url, video_title, tab_id) {
    if (!tab_url || !video_title) {
        return;
    }

    const storedLogs = await AsyncLocalStorage.getStorage(null);
    const candidateLogs = new Map();

    Object.values(storedLogs)
        .filter(log => log?.pssh_data)
        .forEach(log => candidateLogs.set(log.pssh_data, log));
    logs
        .filter(log => log?.pssh_data)
        .forEach(log => candidateLogs.set(log.pssh_data, log));

    const allLogs = Array.from(candidateLogs.values());
    const matchingLogs = allLogs.filter(log => isSameWatchEntry(log.url, tab_url));
    const logsToUpdate = matchingLogs.length > 0
        ? matchingLogs
        : allLogs.slice().reverse().filter(log => !log.video_title).slice(0, 1);
    const changedLogs = [];

    for (const log of logsToUpdate) {
        if (log.video_title === video_title) {
            continue;
        }

        log.video_title = video_title;
        const inMemoryLog = logs.find(entry => entry.pssh_data === log.pssh_data);
        if (inMemoryLog) {
            inMemoryLog.video_title = video_title;
        }
        await AsyncLocalStorage.setStorage({[log.pssh_data]: log});
        changedLogs.push(inMemoryLog || log);
    }

    if (changedLogs.length > 0) {
        await pruneLatestDuplicate(tab_id, changedLogs);
    }
}

async function updateStoredLogClassTitles(tab_url, class_title, tab_id) {
    if (!class_title) {
        return;
    }

    const storedLogs = await AsyncLocalStorage.getStorage(null);
    const candidateLogs = new Map();

    Object.values(storedLogs)
        .filter(log => log?.pssh_data)
        .forEach(log => candidateLogs.set(log.pssh_data, log));
    logs
        .filter(log => log?.pssh_data)
        .forEach(log => candidateLogs.set(log.pssh_data, log));

    const allLogs = Array.from(candidateLogs.values());
    const matchingLogs = tab_url
        ? allLogs.filter(log => isSameWatchEntry(log.url, tab_url))
        : [];
    const logsToUpdate = matchingLogs.length > 0
        ? matchingLogs
        : allLogs.slice().reverse().filter(log => !log.class_title).slice(0, 1);
    const changedLogs = [];

    for (const log of logsToUpdate) {
        if (log.class_title === class_title) {
            continue;
        }

        log.class_title = class_title;
        const inMemoryLog = logs.find(entry => entry.pssh_data === log.pssh_data);
        if (inMemoryLog) {
            inMemoryLog.class_title = class_title;
        }
        await AsyncLocalStorage.setStorage({[log.pssh_data]: log});
        changedLogs.push(inMemoryLog || log);
    }

    if (changedLogs.length > 0) {
        await pruneLatestDuplicate(tab_id, changedLogs);
    }
}

async function parseClearKey(body, sendResponse, tab_url, video_title, class_title, tab_id) {
    const clearkey = JSON.parse(atob(body));

    const formatted_keys = clearkey["keys"].map(key => ({
        ...key,
        kid: Util.bytesToHex(Util.b64.decode(key.kid.replace(/-/g, "+").replace(/_/g, "/") + "==")),
        k: Util.bytesToHex(Util.b64.decode(key.k.replace(/-/g, "+").replace(/_/g, "/") + "=="))
    }));
    const pssh_data = btoa(JSON.stringify({kids: clearkey["keys"].map(key => key.k)}));

    console.log("[WidevineProxy2]", "CLEARKEY KEYS", formatted_keys, tab_url);
    const log = {
        type: "CLEARKEY",
        pssh_data: pssh_data,
        keys: formatted_keys,
        url: tab_url,
        video_title: video_title,
        class_title: class_title,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: manifests.has(tab_url) ? manifests.get(tab_url) : []
    }

    await saveCapturedLog(log, tab_id);
    sendResponse();
}

async function generateChallenge(body, sendResponse) {
    const signed_message =  SignedMessage.decode(Util.b64.decode(body));
    const license_request = LicenseRequest.decode(signed_message.msg);
    const pssh_data = license_request.contentId.widevinePsshData.psshData[0];

    if (!pssh_data) {
        console.log("[WidevineProxy2]", "NO_PSSH_DATA_IN_CHALLENGE");
        sendResponse(body);
        return;
    }

    const selected_device_name = await DeviceManager.getSelectedWidevineDevice();
    if (!selected_device_name) {
        sendResponse(body);
        return;
    }

    const device_b64 = await DeviceManager.loadWidevineDevice(selected_device_name);
    const widevine_device = new WidevineDevice(Util.b64.decode(device_b64).buffer);

    const private_key = `-----BEGIN RSA PRIVATE KEY-----${Util.b64.encode(widevine_device.private_key)}-----END RSA PRIVATE KEY-----`;
    const session = new Session(
        {
            privateKey: private_key,
            identifierBlob: widevine_device.client_id_bytes
        },
        pssh_data
    );

    const [challenge, request_id] = session.createLicenseRequest(LicenseType.STREAMING, widevine_device.type === 2);
    sessions.set(Util.b64.encode(request_id), session);

    sendResponse(Util.b64.encode(challenge));
}

async function parseLicense(body, sendResponse, tab_url, video_title, class_title, tab_id) {
    const license = Util.b64.decode(body);
    const signed_license_message = SignedMessage.decode(license);

    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
        sendResponse();
        return;
    }

    const license_obj = License.decode(signed_license_message.msg);
    const loaded_request_id = Util.b64.encode(license_obj.id.requestId);

    if (!sessions.has(loaded_request_id)) {
        sendResponse();
        return;
    }

    const loadedSession = sessions.get(loaded_request_id);
    const keys = await loadedSession.parseLicense(license);
    const pssh = loadedSession.getPSSH();

    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tab_url);
    const log = {
        type: "WIDEVINE",
        pssh_data: pssh,
        keys: keys,
        url: tab_url,
        video_title: video_title,
        class_title: class_title,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: manifests.has(tab_url) ? manifests.get(tab_url) : []
    }
    await saveCapturedLog(log, tab_id);

    sessions.delete(loaded_request_id);
    sendResponse();
}

async function generateChallengeRemote(body, sendResponse) {
    const signed_message =  SignedMessage.decode(Util.b64.decode(body));
    const license_request = LicenseRequest.decode(signed_message.msg);
    const pssh_data = license_request.contentId.widevinePsshData.psshData[0];

    if (!pssh_data) {
        console.log("[WidevineProxy2]", "NO_PSSH_DATA_IN_CHALLENGE");
        sendResponse(body);
        return;
    }

    const pssh = Session.psshDataToPsshBoxB64(pssh_data);

    const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();
    if (!selected_remote_cdm_name) {
        sendResponse(body);
        return;
    }

    const selected_remote_cdm = JSON.parse(await RemoteCDMManager.loadRemoteCDM(selected_remote_cdm_name));
    const remote_cdm = RemoteCdm.from_object(selected_remote_cdm);

    const session_id = await remote_cdm.open();
    const challenge_b64 = await remote_cdm.get_license_challenge(session_id, pssh, true);

    const signed_challenge_message = SignedMessage.decode(Util.b64.decode(challenge_b64));
    const challenge_message = LicenseRequest.decode(signed_challenge_message.msg);

    sessions.set(Util.b64.encode(challenge_message.contentId.widevinePsshData.requestId), {
        id: session_id,
        pssh: pssh
    });
    sendResponse(challenge_b64);
}

async function parseLicenseRemote(body, sendResponse, tab_url, video_title, class_title, tab_id) {
    const license = Util.b64.decode(body);
    const signed_license_message = SignedMessage.decode(license);

    if (signed_license_message.type !== SignedMessage.MessageType.LICENSE) {
        sendResponse();
        return;
    }

    const license_obj = License.decode(signed_license_message.msg);
    const loaded_request_id = Util.b64.encode(license_obj.id.requestId);

    if (!sessions.has(loaded_request_id)) {
        sendResponse();
        return;
    }

    const session_id = sessions.get(loaded_request_id);

    const selected_remote_cdm_name = await RemoteCDMManager.getSelectedRemoteCDM();
    if (!selected_remote_cdm_name) {
        sendResponse();
        return;
    }

    const selected_remote_cdm = JSON.parse(await RemoteCDMManager.loadRemoteCDM(selected_remote_cdm_name));
    const remote_cdm = RemoteCdm.from_object(selected_remote_cdm);

    await remote_cdm.parse_license(session_id.id, body);
    const returned_keys = await remote_cdm.get_keys(session_id.id, "CONTENT");
    await remote_cdm.close(session_id.id);

    if (returned_keys.length === 0) {
        sendResponse();
        return;
    }

    const keys = returned_keys.map(({ key, key_id }) => ({ k: key, kid: key_id }));

    console.log("[WidevineProxy2]", "KEYS", JSON.stringify(keys), tab_url);
    const log = {
        type: "WIDEVINE",
        pssh_data: session_id.pssh,
        keys: keys,
        url: tab_url,
        video_title: video_title,
        class_title: class_title,
        timestamp: Math.floor(Date.now() / 1000),
        manifests: manifests.has(tab_url) ? manifests.get(tab_url) : []
    }
    await saveCapturedLog(log, tab_id);

    sessions.delete(loaded_request_id);
    sendResponse();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        const tab_url = sender.tab ? sender.tab.url : null;
        const tab_id = sender.tab ? sender.tab.id : null;
        const video_title = rememberVideoTitle(tab_url, message.metadata);
        const class_title = rememberClassTitle(tab_id, message.metadata);

        switch (message.type) {
            case "GET_ALT_LAYOUT_SETTING":
                sendResponse(await SettingsManager.getUseAltClassLayout());
                break;
            case "ALT_LAYOUT_CHANGED":
                try {
                    const allTabs = await chrome.tabs.query({});
                    allTabs.forEach(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {}));
                } catch (e) {}
                sendResponse();
                break;
            case "GET_DEBUG_MODE":
                sendResponse(await isDebugEnabled());
                break;
            case "SET_DEBUG_MODE":
                await setDebugMode(message.enabled === true);
                const debugEnabled = await isDebugEnabled();
                try {
                    const activeTab = await getActiveTab();
                    if (activeTab?.id != null) {
                        await chrome.tabs.sendMessage(activeTab.id, {
                            type: "DEBUG_MODE_CHANGED",
                            payload: {
                                enabled: debugEnabled,
                            },
                        });
                    }
                } catch (err) {
                    console.debug("[WidevineProxy2]", "DEBUG_MODE_CHANGED_FAILED", err);
                }
                sendResponse(debugEnabled);
                break;
            case "DEBUG_EVENT":
                await recordDebugEvent(message.event_type ?? "debug_event", message.detail ?? {}, {tab_id, tab_url});
                sendResponse(await isDebugEnabled());
                break;
            case "GET_DEBUG_EXPORT":
                sendResponse({
                    exported_at: new Date().toISOString(),
                    debug_enabled: await isDebugEnabled(),
                    events: await getDebugEvents(),
                });
                break;
            case "CLEAR_DEBUG":
                await clearDebugEvents();
                sendResponse();
                break;
            case "VIDEO_TITLE":
                await updateStoredLogVideoTitles(tab_url, video_title, tab_id);
                sendResponse();
                break;
            case "CLASS_TITLE":
                await updateStoredLogClassTitles(tab_url, class_title, tab_id);
                sendResponse();
                break;
            case "SET_HOME_URL_TRIGGER":
                sendResponse(await setHomeUrlTrigger(tab_id, tab_url));
                break;
            case "HOME_URL_TRIGGER_SET":
                sendResponse();
                break;
            case "CLASS_CONTEXT_RESET":
                if (tab_id != null) {
                    classTitles.delete(tab_id);
                }
                sendResponse();
                break;
            case "REQUEST":
                if (!await SettingsManager.getEnabled()) {
                    sendResponse(message.body);
                    manifests.clear();
                    videoTitles.clear();
                    classTitles.clear();
                    return;
                }

                try {
                    JSON.parse(atob(message.body));
                    sendResponse(message.body);
                    return;
                } catch {
                    if (message.body) {
                        const device_type = await SettingsManager.getSelectedDeviceType();
                        switch (device_type) {
                            case "WVD":
                                await generateChallenge(message.body, sendResponse);
                                break;
                            case "REMOTE":
                                await generateChallengeRemote(message.body, sendResponse);
                                break;
                        }
                    }
                }
                break;

            case "RESPONSE":
                if (!await SettingsManager.getEnabled()) {
                    sendResponse(message.body);
                    manifests.clear();
                    videoTitles.clear();
                    classTitles.clear();
                    return;
                }

                try {
                    await parseClearKey(message.body, sendResponse, tab_url, video_title, class_title, tab_id);
                    return;
                } catch (e) {
                    const device_type = await SettingsManager.getSelectedDeviceType();
                    switch (device_type) {
                        case "WVD":
                            await parseLicense(message.body, sendResponse, tab_url, video_title, class_title, tab_id);
                            break;
                        case "REMOTE":
                            await parseLicenseRemote(message.body, sendResponse, tab_url, video_title, class_title, tab_id);
                            break;
                    }
                    return;
                }
            case "GET_LOGS":
                sendResponse(logs);
                break;
            case "OPEN_PICKER_WVD":
                chrome.windows.create({
                    url: 'picker/wvd/filePicker.html',
                    type: 'popup',
                    width: 300,
                    height: 200,
                });
                break;
            case "OPEN_PICKER_WVD_MOBILE":
                chrome.tabs.create({
                    url: chrome.runtime.getURL("picker/wvd/filePicker.html")
                });
                break;
            case "OPEN_PICKER_REMOTE":
                chrome.windows.create({
                    url: 'picker/remote/filePicker.html',
                    type: 'popup',
                    width: 300,
                    height: 200,
                });
                break;
            case "OPEN_PICKER_REMOTE_MOBILE":
                chrome.tabs.create({
                    url: chrome.runtime.getURL("picker/remote/filePicker.html")
                });
                break;
            case "CLEAR":
                logs = [];
                manifests.clear();
                videoTitles.clear();
                classTitles.clear();
                IconManager.setDefaultIcon();
                break;
            case "MANIFEST":
                const parsed = JSON.parse(message.body);
                const element = {
                    type: parsed.type,
                    url: parsed.url,
                    headers: requests.has(parsed.url) ? requests.get(parsed.url) : [],
                };

                if (!manifests.has(tab_url)) {
                    manifests.set(tab_url, [element]);
                } else {
                    let elements = manifests.get(tab_url);
                    if (!elements.some(e => e.url === parsed.url)) {
                        elements.push(element);
                        manifests.set(tab_url, elements);
                    }
                }
                sendResponse();
                break;

            // === PW API CRAWLER: Message Handlers ===
            case "API_CAPTURED":
                if (apiRecordingEnabled && message.body) {
                    try {
                        const apiData = JSON.parse(message.body);
                        const path = (() => { try { const u = new URL(apiData.url); return u.origin + u.pathname; } catch { return apiData.url; } })();
                        capturedApis.set(path, apiData);
                        updateAuthToken(apiData.requestHeaders);
                        // Store full-detail entry for debug dump
                        crawlApiLog.push({
                            ts: apiData.timestamp,
                            time: new Date(apiData.timestamp).toISOString().slice(11, 23),
                            url: apiData.url,
                            originalUrl: apiData.originalUrl,
                            method: apiData.method,
                            statusCode: apiData.statusCode,
                            source: apiData.source,
                            requestHeaders: apiData.requestHeaders,
                            responseHeaders: apiData.responseHeaders,
                            responseBody: apiData.responseBody,
                        });
                        if (crawlApiLog.length > CRAWL_API_LOG_MAX) {
                            crawlApiLog = crawlApiLog.slice(-CRAWL_API_LOG_MAX);
                        }
                        crawlDebug('api_captured', {
                            url: path,
                            method: apiData.method,
                            status: apiData.statusCode,
                            hasAuth: !!(apiData.requestHeaders && Object.keys(apiData.requestHeaders).some(k => k.toLowerCase() === 'authorization')),
                        });
                    } catch { /* silent */ }
                }
                sendResponse();
                break;

            case "GET_AUTH_TOKEN":
                {
                    const result = await chrome.storage.local.get('pwAuthToken');
                    sendResponse(result.pwAuthToken || null);
                }
                break;

            case "GET_CRAWLER_DEBUG":
                {
                    const dbgStored = await chrome.storage.local.get('pwAuthToken');
                    const dbgToken = dbgStored.pwAuthToken;
                    sendResponse({
                        token: dbgToken?.token ? dbgToken.token.substring(0, 30) + '...' : null,
                        capturedAt: dbgToken?.capturedAt || null,
                        headerKeys: dbgToken?.capturedHeaders ? Object.keys(dbgToken.capturedHeaders) : [],
                        headerCount: dbgToken?.capturedHeaders ? Object.keys(dbgToken.capturedHeaders).length : 0,
                        crawlerState: pwCrawler?.getState() || null,
                        capturedApiCount: capturedApis.size,
                        apiRecordingEnabled,
                    });
                }
                break;

            case "GET_CAPTURED_APIS":
                sendResponse(Array.from(capturedApis.values()));
                break;

            case "CLEAR_CAPTURED_APIS":
                capturedApis.clear();
                sendResponse();
                break;

            case "TOGGLE_API_RECORDING":
                apiRecordingEnabled = !!message.enabled;
                sendResponse(apiRecordingEnabled);
                break;

            case "CRAWL_START":
                {
                    if (pwCrawler && pwCrawler.getState().state === 'crawling') {
                        sendResponse({ status: 'already_running', ...pwCrawler.getState() });
                        break;
                    }
                    crawlDebug('crawl_start', { depth: message.depth, delayMs: message.delayMs });
                    const startAuth = (await chrome.storage.local.get('pwAuthToken')).pwAuthToken || null;
                    pwCrawler = new PWCrawler({
                        delayMs: message.delayMs || 400,
                        auth: startAuth,
                        // Active full crawl of category → widget → content → playlist
                        // via the confirmed OTT endpoints. Requests run from the
                        // service worker with the captured JWT + PW headers (proven
                        // to return 200). Captures still feed the 'harvest' depth.
                        loadCaptures: async () => crawlApiLog.map(e => ({
                            url: e.url,
                            method: e.method,
                            responseBody: e.responseBody,
                        })),
                        onProgress: (info) => {
                            chrome.runtime.sendMessage({ type: 'CRAWL_PROGRESS', ...info }).catch(() => {});
                        },
                        onDebug: (type, data) => {
                            crawlDebug(`crawler_${type}`, data);
                        },
                    });
                    const depth = message.depth || 'full';
                    startSnapshotTimer();
                    pwCrawler.crawlPiTree(depth).then(async results => {
                        stopSnapshotTimer();
                        const finalState = pwCrawler.getState();
                        crawlDebug('crawl_finished', { state: finalState.state, lectureCount: countLectures(results) });
                        console.log('[PW-Crawler] Crawl finished, state:', finalState.state);
                        await saveCrawlSnapshot();
                        await saveCrawlToHistory(results);
                    }).catch(async err => {
                        stopSnapshotTimer();
                        crawlDebug('crawl_error', { error: err.message, statusCode: err.statusCode });
                        console.warn('[PW-Crawler] Crawl error:', err.message);
                        await saveCrawlSnapshot();
                    });
                    sendResponse({ status: 'started', crawlId: pwCrawler.results?.crawlId });
                }
                break;

            case "CRAWL_PAUSE":
                if (pwCrawler) {
                    pwCrawler.pause();
                    crawlDebug('crawl_paused', pwCrawler.getProgress());
                    sendResponse({ status: 'paused', ...pwCrawler.getState() });
                } else {
                    sendResponse({ status: 'no_crawl' });
                }
                break;

            case "CRAWL_RESUME":
                if (pwCrawler) {
                    pwCrawler.resume();
                    crawlDebug('crawl_resumed', pwCrawler.getProgress());
                    sendResponse({ status: 'resumed', ...pwCrawler.getState() });
                } else {
                    sendResponse({ status: 'no_crawl' });
                }
                break;

            case "CRAWL_STOP":
                if (pwCrawler) {
                    pwCrawler.stop();
                    stopSnapshotTimer();
                    crawlDebug('crawl_stopped', pwCrawler.getProgress());
                    await saveCrawlSnapshot();
                    await saveCrawlToHistory(pwCrawler.getResults());
                    sendResponse({ status: 'stopped', ...pwCrawler.getState() });
                } else {
                    sendResponse({ status: 'no_crawl' });
                }
                break;

            case "CRAWL_GET_STATE":
                if (pwCrawler) {
                    sendResponse(pwCrawler.getState());
                } else {
                    sendResponse({ state: 'idle', progress: null });
                }
                break;

            case "CRAWL_GET_RESULTS":
                if (pwCrawler) {
                    sendResponse(pwCrawler.getResults());
                } else {
                    sendResponse(null);
                }
                break;

            case "CRAWL_GET_FLAT":
                sendResponse(pwCrawler ? getFlatCatalog(pwCrawler.getResults()) : []);
                break;

            case "CRAWL_GET_SUMMARY":
                sendResponse(pwCrawler ? getCrawlSummary(pwCrawler.getResults()) : null);
                break;

            case "CRAWL_GET_HISTORY":
                {
                    const histStored = await chrome.storage.local.get('pwCrawlHistory');
                    sendResponse(histStored.pwCrawlHistory || []);
                }
                break;

            case "CRAWL_CLEAR_HISTORY":
                await chrome.storage.local.remove('pwCrawlHistory');
                sendResponse({ status: 'cleared' });
                break;

            case "CRAWL_RESTORE_HISTORY":
                {
                    const histData = await chrome.storage.local.get('pwCrawlHistory');
                    const historyArr = histData.pwCrawlHistory || [];
                    const entry = historyArr.find(h => h.crawlId === message.crawlId);
                    if (entry && entry.results) {
                        pwCrawler = new PWCrawler({
                            onProgress: (info) => {
                                chrome.runtime.sendMessage({ type: 'CRAWL_PROGRESS', ...info }).catch(() => {});
                            },
                        });
                        pwCrawler.restoreState({
                            state: 'stopped',
                            results: entry.results,
                            progress: { totalCategories: entry.categoryCount || 0, crawledCategories: entry.categoryCount || 0, totalWidgets: 0, crawledWidgets: 0, totalPlaylists: 0, expandedPlaylists: 0, totalLectures: entry.lectureCount, currentPath: '', errors: [] },
                            delayMs: 400,
                            serializedAt: Date.parse(entry.completedAt) || Date.now(),
                        });
                        sendResponse({ status: 'restored', ...pwCrawler.getState() });
                    } else {
                        sendResponse({ status: 'not_found' });
                    }
                }
                break;

            case "CRAWL_CROSSREF_KEYS":
                {
                    if (pwCrawler && pwCrawler.getResults()) {
                        const results = pwCrawler.getResults();
                        const capturedKeyUrls = new Set();
                        const allLogsX = await AsyncLocalStorage.getStorage(null);
                        for (const [, logEntry] of Object.entries(allLogsX)) {
                            if (logEntry?.url) capturedKeyUrls.add(logEntry.url);
                        }
                        let matched = 0;
                        for (const lecture of flattenLectures(results)) {
                            lecture.hasCapturedKey = capturedKeyUrls.has(lecture.watchUrl);
                            if (lecture.hasCapturedKey) matched++;
                        }
                        sendResponse({ matched, results });
                    } else {
                        sendResponse({ matched: 0, results: null });
                    }
                }
                break;
            // === END PW API CRAWLER ===

            case "CRAWL_GET_DEBUG_LOG":
                sendResponse(crawlDebugEvents);
                break;

            case "CRAWL_CLEAR_DEBUG_LOG":
                crawlDebugEvents = [];
                crawlApiLog = [];
                sendResponse({ status: 'cleared' });
                break;

            case "CRAWL_EXPORT_DEBUG":
                {
                    // Build comprehensive debug dump
                    const authToken = await chrome.storage.local.get('pwAuthToken');
                    const dump = {
                        exportedAt: new Date().toISOString(),
                        extension: 'WidevineProxy2-crawler',
                        authToken: authToken.pwAuthToken ? {
                            tokenPreview: authToken.pwAuthToken.token?.substring(0, 30) + '...',
                            capturedAt: authToken.pwAuthToken.capturedAt,
                            capturedHeaders: authToken.pwAuthToken.capturedHeaders,
                            headerCount: authToken.pwAuthToken.capturedHeaders ? Object.keys(authToken.pwAuthToken.capturedHeaders).length : 0,
                        } : null,
                        crawlerState: pwCrawler ? {
                            state: pwCrawler.getState(),
                            results: pwCrawler.getResults(),
                        } : null,
                        capturedApiPatterns: Array.from(capturedApis.entries()).map(([path, data]) => ({
                            path,
                            method: data.method,
                            statusCode: data.statusCode,
                            requestHeaderKeys: data.requestHeaders ? Object.keys(data.requestHeaders) : [],
                            responseHeaderKeys: data.responseHeaders ? Object.keys(data.responseHeaders) : [],
                            responseBodyPreview: typeof data.responseBody === 'string'
                                ? data.responseBody.substring(0, 500)
                                : JSON.stringify(data.responseBody || '').substring(0, 500),
                        })),
                        fullApiLog: crawlApiLog,
                        debugEvents: crawlDebugEvents,
                    };
                    sendResponse(dump);
                }
                break;
        }
    })();
    return true;
});

chrome.runtime.onSuspend.addListener(() => {
    IconManager.setDefaultIcon();
});
