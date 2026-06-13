// pi-harvester/capture-loop.mjs — per-childId capture loop for the Key_Harvester.
//
// Feature: pi-scrape-pipeline — Task 10.2 (capture loop on top of the 10.1 harness).
//
// This is the orchestration that, for a single lecture (childId + watchUrl):
//   1. Forces playback far enough to fire the `encrypted` event → the first EME
//      license exchange (muted autoplay + a play nudge). It does NOT play the
//      whole video (Req 1.1, 1.3).
//   2. Polls the WidevineProxy2 extension for the captured `{kid, key}` pair for
//      THIS lecture (the extension stores a per-watch capture log keyed by
//      pssh_data; the harvester reads that log via the service worker — it does
//      NOT reverse get-otp). Up to the 60s navigation budget (NAV_TIMEOUT_MS)
//      with up to 3 retries (MAX_RETRIES) (Req 1.3, 1.7, 1.8).
//   3. Classifies `drmType` from the DASH manifest's ContentProtection systemId
//      (ClearKey 1077efec-…, Widevine edef8ba9-…), falling back to the captured
//      log `type` (Req 1.4, 1.5, 1.6).
//
// Outcomes per childId (returned, NOT persisted — persistence/resume is Task
// 10.3 via the Key_Catalog model):
//   - captured: { status:'captured', kid, key, kty, drmType, pssh_data, attempts }
//   - failed:   { status:'failed', reason, attempts }   (navigation-timeout |
//               no-usable-key | capture-error)
// A capture yields AT MOST one {kid,key,drmType}; a failure never carries a key,
// so the caller never writes a catalog record for it (Req 2.4, 2.5, 2.6).
//
// Testability (Req 1.x): the raw CDP eval is fully separated from the decision
// logic by INJECTING three collaborators — the 10.1 harness (fresh-tab +
// watchdog), an "extension capture reader", and a "drm resolver"/"mpd source".
// vitest drives the loop with fakes for all three, so the retry counting,
// drmType classification, capture-vs-fail decision, and timeout handling are
// covered with no real browser.
//
// _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2.2, 2.4, 2.5, 2.6_

import { evalIn } from '../cdp-debug.mjs';
import { WatchdogTimeoutError } from './cdp-harness.mjs';
import {
  NAV_TIMEOUT_MS,
  MAX_RETRIES,
  DRM_SYSTEM_IDS,
  DRM_TYPE,
} from '../../../codespaces/pi-pipeline/src/constants.mjs';

/** Capture outcome states for a childId. */
export const CAPTURE_STATUS = Object.freeze({
  CAPTURED: 'captured',
  FAILED: 'failed',
});

/** Failure reasons (R1.7, R1.8). */
export const FAILURE_REASON = Object.freeze({
  NAVIGATION_TIMEOUT: 'navigation-timeout',
  NO_USABLE_KEY: 'no-usable-key',
  CAPTURE_ERROR: 'capture-error',
});

// ---------------------------------------------------------------------------
// Pure DRM classification (testable in isolation; Req 1.4, 1.5, 1.6)
// ---------------------------------------------------------------------------

/** Lowercase, strip an optional `urn:uuid:` prefix, trim — for systemId compare. */
function normalizeSystemId(systemId) {
  return String(systemId || '')
    .toLowerCase()
    .replace(/^urn:uuid:/, '')
    .trim();
}

/**
 * Map a single ContentProtection systemId to a drmType, or null if it is
 * neither the ClearKey nor the Widevine systemId.
 * @param {string} systemId e.g. `1077efec-c0b2-4d02-ace3-3c1e52e2fb4b` or `urn:uuid:edef8ba9-…`.
 * @returns {('CLEARKEY'|'WIDEVINE'|null)}
 */
export function drmTypeForSystemId(systemId) {
  const id = normalizeSystemId(systemId);
  if (!id) return null;
  if (id === DRM_SYSTEM_IDS.WIDEVINE) return DRM_TYPE.WIDEVINE;
  if (id === DRM_SYSTEM_IDS.CLEARKEY) return DRM_TYPE.CLEARKEY;
  return null;
}

/**
 * Classify drmType from a DASH manifest's ContentProtection systemIds. Widevine
 * takes precedence when both systemIds appear (a Widevine asset can also list
 * the cenc mp4protection element); otherwise ClearKey when its systemId is
 * present. Returns null when neither protection systemId is found.
 * @param {string} manifestXml The raw .mpd text.
 * @returns {('CLEARKEY'|'WIDEVINE'|null)}
 */
export function classifyDrmType(manifestXml) {
  if (!manifestXml || typeof manifestXml !== 'string') return null;
  const lower = manifestXml.toLowerCase();
  if (lower.includes(DRM_SYSTEM_IDS.WIDEVINE)) return DRM_TYPE.WIDEVINE;
  if (lower.includes(DRM_SYSTEM_IDS.CLEARKEY)) return DRM_TYPE.CLEARKEY;
  return null;
}

/** Normalise a captured-log `type` ("CLEARKEY"/"WIDEVINE") to a DRM_TYPE value. */
function drmTypeFromCapturedType(type) {
  const t = String(type || '').toUpperCase();
  if (t === DRM_TYPE.WIDEVINE) return DRM_TYPE.WIDEVINE;
  if (t === DRM_TYPE.CLEARKEY) return DRM_TYPE.CLEARKEY;
  return null;
}

// ---------------------------------------------------------------------------
// Capture loop core
// ---------------------------------------------------------------------------

const defaultSleep = (ms) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Build the per-childId capture loop over injected collaborators.
 *
 * @param {object} deps
 * @param {object} deps.harness          The 10.1 CDP harness (createCdpHarness result).
 *                                        Must expose runCapture(watchUrl, fn, {timeoutMs}).
 * @param {{read:(args:{childId:string,watchUrl:string,ctx?:object})=>Promise<?object>}} deps.captureReader
 *                                        Reads the extension's captured pair for the lecture.
 *                                        Returns `{kid, key, kty?, type?, pssh_data?}` or null.
 * @param {(args:{childId:string,watchUrl:string,capturedPair:object})=>Promise<?string>} [deps.drmResolver]
 *                                        Resolves drmType (from the manifest). Optional.
 * @param {(childId:string)=>Promise<?string>} [deps.mpdSource]
 *                                        Fallback: returns manifest XML for a childId; classified here.
 * @param {(ctx:object)=>Promise<any>} [deps.forcePlayback]
 *                                        Drives the tab to fire `encrypted`/EME. Defaults to a no-op.
 * @param {number} [deps.navTimeoutMs]   Per-attempt navigation budget (default 60s).
 * @param {number} [deps.maxRetries]     Max capture attempts (default 3).
 * @param {number} [deps.pollAttempts]   Reader polls per attempt (default 20).
 * @param {number} [deps.pollIntervalMs] Delay between reader polls (default 1500ms).
 * @param {(ms:number)=>Promise<void>} [deps.sleep] Injectable sleep (tests pass a no-op).
 * @param {(msg:string)=>void} [deps.logger]
 */
export function createCaptureLoop({
  harness,
  captureReader,
  drmResolver,
  mpdSource,
  forcePlayback = async () => {},
  navTimeoutMs = NAV_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  pollAttempts = 20,
  pollIntervalMs = 1500,
  sleep = defaultSleep,
  logger = () => {},
} = {}) {
  if (!harness || typeof harness.runCapture !== 'function') {
    throw new Error('createCaptureLoop requires a harness with runCapture()');
  }
  if (!captureReader || typeof captureReader.read !== 'function') {
    throw new Error('createCaptureLoop requires a captureReader with read()');
  }

  /** Resolve drmType: prefer the manifest classification, fall back to the log type. */
  async function resolveDrmType(childId, watchUrl, capturedPair) {
    if (typeof drmResolver === 'function') {
      try {
        const t = await drmResolver({ childId, watchUrl, capturedPair });
        if (t) return t;
      } catch (err) {
        logger(`drmResolver failed for ${childId}: ${err?.message || err}`);
      }
    } else if (typeof mpdSource === 'function') {
      try {
        const t = classifyDrmType(await mpdSource(childId));
        if (t) return t;
      } catch (err) {
        logger(`mpdSource failed for ${childId}: ${err?.message || err}`);
      }
    }
    // Fall back to the DRM type the extension recorded on the captured log.
    return drmTypeFromCapturedType(capturedPair?.type);
  }

  /**
   * One capture attempt inside a fresh tab: nudge playback to the first EME
   * license, then poll the extension for the captured pair. Resolves to the
   * pair (or null if the extension produced nothing within the poll window).
   * Runs UNDER the harness watchdog, so a wedged playback/poll surfaces as a
   * WatchdogTimeoutError at runCapture (→ navigation-timeout).
   */
  async function attemptCapture(ctx, childId, watchUrl) {
    await forcePlayback(ctx);
    for (let poll = 0; poll < pollAttempts; poll += 1) {
      const pair = await captureReader.read({ childId, watchUrl, ctx });
      if (pair && pair.kid && pair.key) return pair;
      if (poll < pollAttempts - 1) await sleep(pollIntervalMs);
    }
    return null;
  }

  function failed(childId, watchUrl, reason, attempts) {
    return { childId, watchUrl, status: CAPTURE_STATUS.FAILED, reason, attempts };
  }

  /**
   * Capture a single lecture. Returns a structured result; NEVER persists and
   * NEVER returns a key on failure (Req 2.4–2.6).
   *
   * @param {{childId:string, watchUrl:string}} lecture
   */
  async function captureChildId(lecture) {
    const { childId, watchUrl } = lecture || {};
    if (!childId || !watchUrl) {
      return failed(childId, watchUrl, FAILURE_REASON.CAPTURE_ERROR, 0);
    }

    let attempts = 0;
    let lastErrorReason = FAILURE_REASON.NO_USABLE_KEY;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      attempts = attempt;
      let pair;
      try {
        pair = await harness.runCapture(
          watchUrl,
          (ctx) => attemptCapture(ctx, childId, watchUrl),
          { timeoutMs: navTimeoutMs },
        );
      } catch (err) {
        if (err instanceof WatchdogTimeoutError) {
          // Navigation/playback did not complete within the 60s budget. This is
          // a decisive failure: record it and let the caller continue (R1.7).
          logger(`navigation timeout for ${childId} (attempt ${attempt})`);
          return failed(childId, watchUrl, FAILURE_REASON.NAVIGATION_TIMEOUT, attempts);
        }
        lastErrorReason = FAILURE_REASON.CAPTURE_ERROR;
        logger(`capture error for ${childId} (attempt ${attempt}): ${err?.message || err}`);
        continue; // transient capture error — retry within the budget
      }

      if (pair && pair.kid && pair.key) {
        const drmType = await resolveDrmType(childId, watchUrl, pair);
        return {
          childId,
          watchUrl,
          status: CAPTURE_STATUS.CAPTURED,
          kid: pair.kid,
          key: pair.key,
          kty: pair.kty || 'oct',
          drmType,
          pssh_data: pair.pssh_data,
          attempts,
        };
      }

      lastErrorReason = FAILURE_REASON.NO_USABLE_KEY;
      logger(`no key captured for ${childId} on attempt ${attempt}`);
    }

    // Exhausted all retries with no usable {kid,key} (R1.8).
    return failed(childId, watchUrl, lastErrorReason, attempts);
  }

  return { captureChildId, resolveDrmType, attemptCapture };
}

// ---------------------------------------------------------------------------
// Production collaborators (live CDP wiring; not exercised by the unit tests)
// ---------------------------------------------------------------------------

/**
 * Production "extension capture reader": reads the WidevineProxy2 captured logs
 * out of the extension service worker's `chrome.storage.local` and returns the
 * `{kid, key}` pair whose log URL matches this lecture's childId. The extension
 * stores each captured log keyed by pssh_data as
 * `{type, pssh_data, keys:[{k,kid,kty?}], url, ...}` (see background.js
 * parseClearKey / parseLicense). Both ClearKey and Widevine land here with hex
 * `{k, kid}`.
 *
 * @param {object} args
 * @param {object} args.browser      cdp-debug.mjs Browser-like client.
 * @param {string} args.swSessionId  Attached service-worker session id.
 */
export function createExtensionCaptureReader({ browser, swSessionId }) {
  if (!browser || !swSessionId) {
    throw new Error('createExtensionCaptureReader requires { browser, swSessionId }');
  }
  return {
    async read({ childId, watchUrl }) {
      const target = JSON.stringify(watchUrl);
      const childTarget = JSON.stringify(childId);
      // Match by childId (origin+pathname+childId) mirroring background.js
      // isSameWatchEntry, with a childId-substring fallback. After a match the
      // consumed capture log(s) are REMOVED from SW storage: the Key_Catalog is
      // the durable store, so keeping the extension's chrome.storage.local
      // bounded keeps every `get(null)` fast across a 30k+ run. If the process
      // dies between this read and the catalog write, resume simply re-captures
      // that childId (it replays the lecture) — no data is lost or corrupted.
      const expr = `(async () => {
        const all = await chrome.storage.local.get(null);
        const want = ${target};
        const wantChild = ${childTarget};
        let wantChildId = wantChild;
        try { wantChildId = new URL(want).searchParams.get('childId') || wantChild; } catch {}
        const matchedKeys = [];
        let best = null;
        for (const [key, log] of Object.entries(all)) {
          if (!log || !log.url || !Array.isArray(log.keys) || log.keys.length === 0) continue;
          let logChildId = null;
          try { logChildId = new URL(log.url).searchParams.get('childId'); } catch {}
          const hit = (logChildId && wantChildId && logChildId === wantChildId)
            || (log.url === want)
            || (wantChildId && log.url.includes(wantChildId));
          if (hit) {
            matchedKeys.push(key);
            if (!best || (log.timestamp || 0) > (best.timestamp || 0)) best = log;
          }
        }
        if (!best) return null;
        try { await chrome.storage.local.remove(matchedKeys); } catch {}
        const k0 = best.keys[0];
        return { kid: k0.kid, key: k0.k, kty: k0.kty || 'oct', type: best.type, pssh_data: best.pssh_data };
      })()`;
      return evalIn(browser, swSessionId, expr);
    },
  };
}

/**
 * Production "drm resolver": resolves a childId's signed manifest in the
 * extension SW (host permissions bypass page CORS), fetches the .mpd from
 * CloudFront, and classifies the DRM from its ContentProtection systemId
 * (mirrors probe-drm.mjs / probe-mpd.mjs).
 *
 * @param {object} args
 * @param {object} args.browser
 * @param {string} args.swSessionId
 */
export function createMpdDrmResolver({ browser, swSessionId }) {
  if (!browser || !swSessionId) {
    throw new Error('createMpdDrmResolver requires { browser, swSessionId }');
  }
  return async ({ childId }) => {
    const expr = `(async () => {
      const a = (await chrome.storage.local.get('pwAuthToken')).pwAuthToken;
      if (!a || !a.token) return null;
      const headers = { ...(a.capturedHeaders || {}), Authorization: 'Bearer ' + a.token };
      const u = 'https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId=' + ${JSON.stringify(childId)} + '&clientVersion=201';
      const r = await fetch(u, { headers });
      let j; try { j = await r.json(); } catch { return null; }
      if (!j || !j.data || !j.data.url) return null;
      const mpd = await (await fetch(j.data.url + (j.data.signedUrl || ''))).text();
      return mpd;
    })()`;
    const mpd = await evalIn(browser, swSessionId, expr);
    return classifyDrmType(mpd);
  };
}

/**
 * Production playback nudge: mutes the video and clicks play (with a user
 * gesture) so the player reaches the first `encrypted` event without playing
 * the whole video. Mirrors the proven nudge in probe-stream.mjs.
 *
 * @param {object} args
 * @param {object} args.browser
 */
export function createForcePlayback({ browser }) {
  if (!browser) throw new Error('createForcePlayback requires { browser }');
  const NUDGE = `(()=>{try{const v=document.querySelector('video');`
    + `if(v){v.muted=true;v.play&&v.play().catch(()=>{});}`
    + `const b=[...document.querySelectorAll('button,[role="button"]')]`
    + `.find(x=>/play/i.test(x.getAttribute('aria-label')||''));`
    + `b&&b.click&&b.click();return !!v;}catch(e){return 'err:'+e.message;}})()`;
  return async (ctx) => {
    try {
      return await evalIn(browser, ctx.sessionId, NUDGE);
    } catch {
      return false;
    }
  };
}
