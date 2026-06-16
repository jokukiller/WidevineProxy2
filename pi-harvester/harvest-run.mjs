// pi-harvester/harvest-run.mjs — the Key_Harvester run loop (persistence,
// resume, subject-priority ordering, bounded concurrency, progress heartbeat).
//
// Feature: pi-scrape-pipeline — Task 10.3.
//
// This ties the pure Key_Catalog model (task 2, codespaces/pi-pipeline/src/
// key-catalog.mjs) to the per-childId capture loop (task 10.2, capture-loop.mjs)
// to produce a complete, resumable, outage-tolerant harvest run. It encodes:
//
//   - Deduped work set from the catalog inputs (Asset_Catalog + Placement_Catalog),
//     keyed by `childId`, so the ~6,831 cross-branch duplicate placements never
//     trigger a second capture (Req 1.1, 2.1).
//   - Subject-priority ordering (Req 4.3): work items are emitted subject by
//     subject (first-seen subject order, first-seen childId order within a
//     subject), so a subject becomes key-complete as early as possible and can
//     feed the remote publish queue while the rest of the catalog is still being
//     harvested. `--subject "<name>"` restricts the run to a single subject.
//   - Resume (Req 3.2, 3.3, 14.4–14.6): on start the existing Key_Catalog is
//     loaded and `KeyCatalog.pending` is used to re-attempt only the non-captured
//     childIds; a childId already `captured` is SKIPPED and never re-captured.
//   - Persist-before-advance (Req 3.1): after each successful capture the loop
//     does `KeyCatalog.put` then an ATOMIC save and only then frees the worker to
//     pull the next childId. On a save failure it reverts the in-memory entry,
//     marks the childId failed, and surfaces an error identifying it (Req 3.6) —
//     the previously persisted catalog stays intact.
//   - Bounded concurrency (Req 14.4): `--concurrency N` parallel capture tabs,
//     but every atomic Key_Catalog write is SERIALIZED through a single write
//     mutex so concurrent captures can never corrupt or lose a write.
//   - Progress heartbeat: a fixed-interval, injectable sink reporting
//     captured/pending/failed counts, the in-flight childId(s), and an ETA, so a
//     multi-hour unattended run is monitorable by polling output.
//   - Run accounting (Req 16.4): the final report's captured + failed + skipped
//     equals attempted.
//
// Testability: the capture function (`captureChildId`), the catalog + its
// persistence, the clock, the heartbeat sink, and the interval scheduler are all
// INJECTED, so vitest can drive a full run with fake captures over a temp-file
// catalog — no browser.
//
// _Requirements: 3.1, 3.6, 4.3, 14.4, 14.5, 14.6, 16.4_

import { CAPTURE_STATUS } from './capture-loop.mjs';
import { ensurePlayableWatchUrl } from '../../../codespaces/pi-pipeline/src/watch-url.mjs';

// ---------------------------------------------------------------------------
// Work set construction (dedup by childId + subject-priority ordering)
// ---------------------------------------------------------------------------

/** Read the childId out of a watchUrl, falling back to the placement field. */
function childIdOf(placement) {
  return placement && typeof placement.childId === 'string' ? placement.childId : null;
}

/**
 * Build the deduped, subject-ordered work set from the catalog inputs.
 *
 * Each unique `childId` appears exactly once (Req 1.1, 2.1), assigned to the
 * FIRST subject in which it is seen, and emitted in subject-priority order
 * (subjects in first-seen order; childIds in first-seen order within their
 * subject) so key-complete subjects surface as early as possible (Req 4.3).
 *
 * @param {object} args
 * @param {Array<object>} [args.assets]     Asset_Catalog rows (universe of childIds; optional).
 * @param {Array<object>} args.placements   Placement_Catalog rows ({childId, subject, watchUrl, ...}).
 * @param {string} [args.subject]           Restrict the work set to a single subject (Req 4.3).
 * @returns {Array<{childId:string, watchUrl:string, subject:(string|null)}>}
 */
export function buildWorkSet({ assets, placements, subject } = {}) {
  if (!Array.isArray(placements)) {
    throw new TypeError('buildWorkSet requires a placements array');
  }
  const wantSubject = typeof subject === 'string' && subject.length > 0 ? subject : null;

  // Optional: restrict the universe of childIds to those present in the
  // Asset_Catalog (a placement referencing an unknown childId is skipped).
  const assetIds =
    Array.isArray(assets) && assets.length > 0
      ? new Set(assets.map((a) => (a && typeof a.childId === 'string' ? a.childId : null)).filter(Boolean))
      : null;

  const subjectOrder = []; // subject names in first-seen order
  const bySubject = new Map(); // subject -> [{childId, watchUrl, subject}]
  const assignedSubject = new Map(); // childId -> the subject it was assigned to

  for (const p of placements) {
    const childId = childIdOf(p);
    if (!childId) continue;
    if (assetIds && !assetIds.has(childId)) continue;
    const subj = typeof p.subject === 'string' ? p.subject : null;
    if (wantSubject && subj !== wantSubject) continue;

    // Dedup: a childId is captured once, under the first subject it appears in.
    if (assignedSubject.has(childId)) continue;

    const groupKey = subj ?? '';
    if (!bySubject.has(groupKey)) {
      bySubject.set(groupKey, []);
      subjectOrder.push(groupKey);
    }
    assignedSubject.set(childId, groupKey);
    bySubject.get(groupKey).push({
      childId,
      // The stored watchUrl is MISSING vType/type, which makes the player hang
      // on capture (the bug). Ensure the harvester navigates to the playable URL.
      watchUrl: ensurePlayableWatchUrl(typeof p.watchUrl === 'string' ? p.watchUrl : ''),
      subject: subj,
    });
  }

  const out = [];
  for (const key of subjectOrder) {
    for (const item of bySubject.get(key)) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write mutex (serialize all atomic catalog writes; Req 14.4)
// ---------------------------------------------------------------------------

/**
 * A minimal promise-chain mutex. Each task runs only after the previous one
 * settles, so concurrent capture workers can never interleave catalog writes.
 */
function createWriteMutex() {
  let chain = Promise.resolve();
  return function runExclusive(fn) {
    const result = chain.then(() => fn());
    // Advance the chain regardless of this task's outcome so one failed write
    // never wedges the queue.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// ---------------------------------------------------------------------------
// Default interval scheduler (unref'd so the heartbeat never keeps the process
// alive on its own).
// ---------------------------------------------------------------------------

const defaultScheduler = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h),
};

// ---------------------------------------------------------------------------
// Harvest run
// ---------------------------------------------------------------------------

/**
 * Create a harvest run over injected collaborators.
 *
 * @param {object} deps
 * @param {Array<{childId:string, watchUrl:string, subject?:string}>} deps.workItems
 *        Deduped, subject-ordered work set (from buildWorkSet).
 * @param {import('../../../codespaces/pi-pipeline/src/key-catalog.mjs').KeyCatalog} deps.catalog
 *        The KeyCatalog instance to persist into.
 * @param {string} [deps.catalogPath]   Destination path for catalog.save (required unless saveCatalog given).
 * @param {(args:{childId:string,watchUrl:string,subject?:string})=>Promise<object>} deps.captureChildId
 *        The capture function (createCaptureLoop().captureChildId in production; a fake in tests).
 * @param {number} [deps.concurrency]    Parallel capture workers (default 1).
 * @param {()=>number} [deps.clock]      Injectable clock (ms). Default Date.now.
 * @param {(snapshot:object)=>void} [deps.heartbeatSink]  Progress sink; omit to disable.
 * @param {number} [deps.heartbeatIntervalMs]  Heartbeat cadence (default 30s).
 * @param {{setInterval:Function, clearInterval:Function}} [deps.scheduler]  Injectable timers.
 * @param {()=>Promise<void>} [deps.saveCatalog]  Override the persistence step (tests inject failures).
 * @param {(msg:string)=>void} [deps.logger]
 */
export function createHarvestRun({
  workItems,
  catalog,
  catalogPath,
  captureChildId,
  concurrency = 1,
  clock = () => Date.now(),
  heartbeatSink,
  heartbeatIntervalMs = 30_000,
  scheduler = defaultScheduler,
  saveCatalog,
  skipFailed = false,
  logger = () => {},
} = {}) {
  if (!Array.isArray(workItems)) {
    throw new TypeError('createHarvestRun requires a workItems array');
  }
  if (!catalog || typeof catalog.put !== 'function' || typeof catalog.has !== 'function') {
    throw new TypeError('createHarvestRun requires a KeyCatalog instance');
  }
  if (typeof captureChildId !== 'function') {
    throw new TypeError('createHarvestRun requires a captureChildId function');
  }
  const save =
    typeof saveCatalog === 'function'
      ? saveCatalog
      : (() => {
          if (typeof catalogPath !== 'string' || catalogPath.length === 0) {
            throw new TypeError('createHarvestRun requires catalogPath or saveCatalog');
          }
          return () => catalog.save(catalogPath);
        })();

  const runExclusive = createWriteMutex();

  // Partition the work set against the persisted state (Req 3.2, 3.3): a childId
  // already `captured` is SKIPPED; everything else is pending and re-attempted.
  // WHEN skipFailed is set, a childId already recorded `failed` is ALSO skipped
  // (not re-attempted) — this avoids re-grinding the known-perpetual failures
  // (unencrypted/dead lectures) on every resume. Default off so a final mop-up
  // run (no flag) still re-attempts failures, e.g. to retry transient ones.
  const attempted = workItems.length;
  const pendingItems = [];
  let skipped = 0;
  for (const item of workItems) {
    if (catalog.has(item.childId)) skipped += 1;
    else if (
      skipFailed &&
      catalog.failed &&
      Object.prototype.hasOwnProperty.call(catalog.failed, item.childId)
    ) {
      skipped += 1;
    } else {
      pendingItems.push(item);
    }
  }

  const capturedList = []; // { childId, subject, drmType }
  const failures = []; // { childId, subject, reason }
  const errors = []; // { childId, error } — operator-facing, identifies the childId (Req 3.6)
  const inFlight = new Set();
  let completed = 0;
  let startedAt = 0;

  /** Build a heartbeat snapshot of live progress (Req 16.4 surface + ETA). */
  function snapshot() {
    const now = clock();
    const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
    const remaining = Math.max(0, pendingItems.length - completed);
    let etaMs = null;
    if (completed > 0 && elapsedMs > 0) {
      etaMs = Math.round((elapsedMs / completed) * remaining);
    }
    return {
      attempted,
      skipped,
      captured: capturedList.length,
      failed: failures.length,
      pending: remaining,
      inProgress: completed + skipped + failures.length, // monotonic progress marker
      current: [...inFlight],
      elapsedMs,
      etaMs,
    };
  }

  function emitHeartbeat() {
    if (typeof heartbeatSink !== 'function') return;
    try {
      heartbeatSink(snapshot());
    } catch (err) {
      logger(`heartbeat sink threw: ${err?.message || err}`);
    }
  }

  /**
   * Persist a successful capture: put + atomic save BEFORE the worker advances
   * (Req 3.1), serialized through the write mutex (Req 14.4). On a save failure,
   * revert the in-memory entry, mark the childId failed, and surface an error
   * that identifies it; the previously persisted catalog is left intact (Req 3.6).
   */
  async function persistCapture(item, result) {
    return runExclusive(async () => {
      const added = catalog.put(item.childId, {
        kid: result.kid,
        key: result.key,
        kty: result.kty,
        drmType: result.drmType,
        capturedAt: Math.floor(clock() / 1000),
      });
      try {
        await save();
        return { ok: true };
      } catch (err) {
        // Roll back the in-memory put so the catalog matches durable storage,
        // then record the failure keyed by the affected childId (Req 3.6).
        if (added) delete catalog.entries[item.childId];
        catalog.markFailed(item.childId, `persist-failed: ${err?.message || err}`);
        return { ok: false, error: err };
      }
    });
  }

  /**
   * Persist a capture failure: markFailed (never touches a captured entry,
   * Req 2.5) then best-effort save the failed state. A save failure here is
   * non-fatal — the captured set is already safe — so it is logged, not escalated.
   */
  async function persistFailure(item, reason) {
    return runExclusive(async () => {
      catalog.markFailed(item.childId, reason);
      try {
        await save();
      } catch (err) {
        logger(`save after markFailed failed for ${item.childId}: ${err?.message || err}`);
      }
    });
  }

  let cursor = 0;
  async function worker() {
    while (cursor < pendingItems.length) {
      const item = pendingItems[cursor];
      cursor += 1;
      inFlight.add(item.childId);
      try {
        let result;
        try {
          result = await captureChildId({
            childId: item.childId,
            watchUrl: item.watchUrl,
            subject: item.subject,
          });
        } catch (err) {
          // An exception from the capture loop is treated as a failed capture;
          // the captured set is never mutated.
          failures.push({ childId: item.childId, subject: item.subject, reason: 'capture-exception' });
          errors.push({ childId: item.childId, error: String(err?.message || err) });
          await persistFailure(item, 'capture-exception');
          continue;
        }

        if (result && result.status === CAPTURE_STATUS.CAPTURED && result.kid && result.key) {
          const persisted = await persistCapture(item, result);
          if (persisted.ok) {
            capturedList.push({ childId: item.childId, subject: item.subject, drmType: result.drmType });
          } else {
            failures.push({ childId: item.childId, subject: item.subject, reason: 'persist-failed' });
            errors.push({
              childId: item.childId,
              error: `persist-failed: ${persisted.error?.message || persisted.error}`,
            });
          }
        } else {
          const reason = (result && result.reason) || 'capture-failed';
          failures.push({ childId: item.childId, subject: item.subject, reason });
          await persistFailure(item, reason);
        }
      } finally {
        inFlight.delete(item.childId);
        completed += 1;
      }
    }
  }

  /** Execute the full harvest run and resolve to the final accounting report. */
  async function run() {
    startedAt = clock();
    let hbHandle;
    if (typeof heartbeatSink === 'function' && heartbeatIntervalMs > 0) {
      hbHandle = scheduler.setInterval(emitHeartbeat, heartbeatIntervalMs);
    }
    try {
      const n = Math.max(1, Math.min(concurrency | 0 || 1, pendingItems.length || 1));
      const workers = [];
      for (let i = 0; i < n; i += 1) workers.push(worker());
      await Promise.all(workers);
    } finally {
      if (hbHandle !== undefined) scheduler.clearInterval(hbHandle);
    }

    // A final heartbeat so the last counts are always emitted.
    emitHeartbeat();

    const report = {
      attempted,
      skipped,
      captured: capturedList.length,
      failed: failures.length,
      captures: capturedList,
      failures,
      errors,
    };
    // Run accounting invariant (Req 16.4): captured + failed + skipped == attempted.
    report.accountingOk = report.captured + report.failed + report.skipped === report.attempted;
    logger(
      `harvest complete: attempted=${report.attempted} captured=${report.captured} ` +
        `failed=${report.failed} skipped=${report.skipped}`,
    );
    return report;
  }

  return { run, snapshot, pendingCount: pendingItems.length, skippedCount: skipped, attempted };
}

export default createHarvestRun;
