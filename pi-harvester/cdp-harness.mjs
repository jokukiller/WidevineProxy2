// pi-harvester/cdp-harness.mjs — LOCAL CDP harness for the Key_Harvester.
//
// Feature: pi-scrape-pipeline — Task 10.1 (CDP harness reusing cdp-debug.mjs).
//
// This is the browser+CDM-driving glue the Key_Harvester capture loop (Task
// 10.2) sits on top of. It encodes the operational quirks that were all hit
// LIVE while driving Opera GX + the WidevineProxy2 extension over CDP (see
// .kiro/specs/pi-scrape-pipeline/HANDOFF.md §1):
//
//   - FRESH tab per lecture. The PW watch page arms a `beforeunload`
//     "Leave site?" dialog that BLOCKS `Page.navigate` and deadlocks CDP, so a
//     watch tab is NEVER reused — every lecture gets a brand-new tab via
//     `Target.createTarget` and the tab is closed afterwards (Req 1.3).
//   - Auto-accept dialogs. A `Page.javascriptDialogOpening` handler immediately
//     answers `Page.handleJavaScriptDialog{accept:true}` so the beforeunload (or
//     any alert/confirm) can never wedge the session.
//   - MV3 service-worker wake. The extension's service worker idles; it is woken
//     by opening `chrome-extension://<extId>/panel/panel.html`.
//   - Single attach per target. A second `Target.attachToTarget` on the same
//     target throws a CDP `sessionId` protocol error, so each target is attached
//     exactly once and the sessionId is cached/reused.
//   - Global watchdog. A per-lecture watchdog force-aborts a stuck capture after
//     a timeout (NAV_TIMEOUT_MS by default, injectable), closing the tab and
//     freeing the slot so one stuck lecture can never hang the whole run
//     (Req 1.3, 14.3).
//
// Design for testability (Req 14.3): all of the above logic is separated from
// raw CDP I/O by injecting a Browser-like client (the `cdp-debug.mjs` `Browser`
// class in production, a fake in tests). The factory takes that client plus
// injectable timers, so the single-attach guard, watchdog timer, dialog handler
// registration, and fresh-tab lifecycle can be driven by vitest with NO real
// Opera/CDP.
//
// _Requirements: 1.3, 14.3_

import { matchTarget } from '../cdp-debug.mjs';
import { NAV_TIMEOUT_MS } from '../../../codespaces/pi-pipeline/src/constants.mjs';

/** Dev-copy WidevineProxy2 extension id (Opera GX). Overridable via options. */
export const DEFAULT_EXT_ID = 'pkoikjplcdkipeogmopelecfnfpaddcl';

/** Default settle time after opening the panel to let the MV3 SW spin up. */
const DEFAULT_SW_WAKE_DELAY_MS = 1200;

/** Thrown when the global per-lecture watchdog force-aborts a stuck capture. */
export class WatchdogTimeoutError extends Error {
  constructor(watchUrl, timeoutMs) {
    super(`capture watchdog fired after ${timeoutMs}ms for ${watchUrl}`);
    this.name = 'WatchdogTimeoutError';
    this.watchUrl = watchUrl;
    this.timeoutMs = timeoutMs;
  }
}

/** Locate the extension's service-worker target (un-woken lookup). */
function findSwTarget(targets, extId) {
  return matchTarget(targets, 'service_worker').find((t) => (t.url || '').includes(extId));
}

/**
 * Create a CDP harness over a Browser-like client.
 *
 * @param {object} opts
 * @param {object} opts.browser   Browser-like client: { send(method, params, sessionId),
 *                                 attach(targetId)->sessionId, targets()->[...],
 *                                 onEvent(fn), close() }. The cdp-debug.mjs `Browser`
 *                                 satisfies this; tests inject a fake.
 * @param {string} [opts.extId]   WidevineProxy2 extension id.
 * @param {number} [opts.navTimeoutMs] Per-lecture watchdog budget (default 60s).
 * @param {number} [opts.swWakeDelayMs] Settle delay after opening the panel page.
 * @param {(msg:string)=>void} [opts.logger] Optional progress logger.
 * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers] Injectable timers.
 */
export function createCdpHarness({
  browser,
  extId = DEFAULT_EXT_ID,
  navTimeoutMs = NAV_TIMEOUT_MS,
  swWakeDelayMs = DEFAULT_SW_WAKE_DELAY_MS,
  logger = () => {},
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (!browser || typeof browser.send !== 'function') {
    throw new Error('createCdpHarness requires a Browser-like client with send()/attach()/targets()/onEvent()');
  }

  // Single-attach guard: targetId -> sessionId (attaching twice throws a CDP error).
  const sessionByTarget = new Map();
  // sessionIds for which we've registered a dialog auto-accept guard.
  const dialogSessions = new Set();
  // targetIds this harness opened (so cleanup only touches our own tabs).
  const ownedTargets = new Set();

  let dialogListenerInstalled = false;
  let dialogsAccepted = 0;
  let createTargetCalls = 0;
  let attachCalls = 0;

  const delay = (ms) =>
    ms > 0 ? new Promise((resolve) => timers.setTimeout(resolve, ms)) : Promise.resolve();

  // Install exactly ONE browser-level event listener. It auto-accepts dialogs,
  // but only for sessions we've explicitly registered, so it never interferes
  // with tabs the harness doesn't own.
  function ensureDialogListener() {
    if (dialogListenerInstalled) return;
    dialogListenerInstalled = true;
    browser.onEvent((msg) => {
      if (!msg || msg.method !== 'Page.javascriptDialogOpening') return;
      // Flat-session messages carry a sessionId; only handle our registered ones.
      if (msg.sessionId && !dialogSessions.has(msg.sessionId)) return;
      dialogsAccepted += 1;
      logger(`auto-accepting javascript dialog (session ${msg.sessionId || '?'})`);
      // accept:true dismisses the beforeunload "Leave site?" prompt so it can
      // never block Page.navigate / deadlock CDP.
      Promise.resolve(
        browser.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId),
      ).catch(() => {});
    });
  }

  /**
   * Attach to a target EXACTLY once. A repeat attach to the same target throws
   * a CDP `sessionId` protocol error, so the first sessionId is cached and
   * reused for every subsequent request.
   */
  async function attachOnce(targetId) {
    if (sessionByTarget.has(targetId)) return sessionByTarget.get(targetId);
    attachCalls += 1;
    const sessionId = await browser.attach(targetId);
    sessionByTarget.set(targetId, sessionId);
    return sessionId;
  }

  /** Register the dialog auto-accept guard for a session and enable Page events. */
  async function registerDialogHandler(sessionId) {
    ensureDialogListener();
    if (dialogSessions.has(sessionId)) return;
    dialogSessions.add(sessionId);
    // Page domain must be enabled for javascriptDialogOpening to fire.
    await Promise.resolve(browser.send('Page.enable', {}, sessionId)).catch(() => {});
  }

  /**
   * Wake the idling MV3 service worker by opening the extension panel page, then
   * attach to the SW target. Returns the SW sessionId (or null if it never
   * appeared) plus the panel tab targetId so the caller can close it.
   */
  async function wakeServiceWorker() {
    let targets = await browser.targets();
    let sw = findSwTarget(targets, extId);
    if (sw) {
      return { sessionId: await attachOnce(sw.targetId), targetId: sw.targetId, woke: false };
    }
    logger('waking MV3 service worker via panel.html');
    const { targetId: panelTargetId } = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extId}/panel/panel.html`,
    });
    createTargetCalls += 1;
    ownedTargets.add(panelTargetId);
    await delay(swWakeDelayMs);
    targets = await browser.targets();
    sw = findSwTarget(targets, extId);
    return {
      sessionId: sw ? await attachOnce(sw.targetId) : null,
      targetId: sw ? sw.targetId : null,
      panelTargetId,
      woke: true,
    };
  }

  /**
   * Open a FRESH tab for a lecture. NEVER reuses a watch tab (the beforeunload
   * deadlock). Attaches once, registers the dialog guard, and navigates.
   */
  async function openLectureTab(watchUrl) {
    const { targetId } = await browser.send('Target.createTarget', { url: watchUrl });
    createTargetCalls += 1;
    ownedTargets.add(targetId);
    const sessionId = await attachOnce(targetId);
    await registerDialogHandler(sessionId);
    // The PW player only advances when the tab believes it is visible AND
    // focused: a backgrounded CDP tab stays paused (readyState stalls, the
    // `encrypted` event never fires → no license exchange → no key captured).
    // This was the silent "0 captures / navigation-timeout" failure (HANDOFF
    // §bug-4). Bring the tab to the front AND enable focus emulation per-session
    // so EME proceeds even when another tab is the real foreground one — needed
    // for --concurrency > 1, where only ONE tab can truly be on top but every
    // session must still report itself focused. Both are best-effort.
    await Promise.resolve(browser.send('Page.bringToFront', {}, sessionId)).catch(() => {});
    await Promise.resolve(
      browser.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId),
    ).catch(() => {});
    return { targetId, sessionId, watchUrl };
  }

  /** Close a tab opened by this harness and drop its tracking state. */
  async function closeTab(targetId) {
    if (!targetId) return;
    const sessionId = sessionByTarget.get(targetId);
    try {
      await Promise.resolve(browser.send('Target.closeTarget', { targetId }));
    } finally {
      ownedTargets.delete(targetId);
      sessionByTarget.delete(targetId);
      if (sessionId) dialogSessions.delete(sessionId);
    }
  }

  /**
   * Drive one capture inside a fresh tab under the global watchdog.
   *
   * Opens a fresh tab, runs `captureFn({ targetId, sessionId, watchUrl })`, and
   * races it against the watchdog. If the capture is stuck past `timeoutMs`, the
   * watchdog force-aborts: the tab is closed and a WatchdogTimeoutError is
   * thrown, so a single stuck lecture can never hang the run. The tab is ALWAYS
   * closed on the way out (success, failure, or timeout).
   *
   * @param {string} watchUrl
   * @param {(ctx:{targetId:string,sessionId:string,watchUrl:string})=>Promise<any>} captureFn
   * @param {{timeoutMs?:number}} [opts]
   */
  async function runCapture(watchUrl, captureFn, { timeoutMs = navTimeoutMs } = {}) {
    const tab = await openLectureTab(watchUrl);
    let timer;
    const watchdog = new Promise((_resolve, reject) => {
      timer = timers.setTimeout(() => {
        logger(`watchdog force-abort for ${watchUrl} after ${timeoutMs}ms`);
        reject(new WatchdogTimeoutError(watchUrl, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => captureFn(tab)),
        watchdog,
      ]);
    } finally {
      timers.clearTimeout(timer);
      // Free the tab/resources regardless of outcome (Req 1.3, 14.3).
      await closeTab(tab.targetId).catch(() => {});
    }
  }

  /** Close every tab the harness still owns (best-effort run teardown). */
  async function closeAllTabs() {
    const ids = [...ownedTargets];
    await Promise.all(ids.map((id) => closeTab(id).catch(() => {})));
  }

  /**
   * Close leftover PW watch tabs from a PRIOR run. A harvest process that is
   * hard-killed (e.g. an operator stop, a crash) never runs its per-capture
   * `closeTab`/`closeAllTabs`, so the watch tabs it had in flight are orphaned
   * and keep DECODING video in the background — they pile up across restarts and
   * lag the machine. A freshly-started harness owns NO tabs, so any existing
   * watch page target (url contains "/watch") is by definition such an orphan.
   * Call this ONCE at startup (before the run) to make every (re)start
   * self-cleaning. Best-effort and never throws. Returns the number closed.
   */
  async function closeStaleWatchTabs() {
    let closed = 0;
    try {
      const targets = await browser.targets();
      for (const t of targets) {
        const isPage = (t.type || '').toLowerCase() === 'page';
        const isWatch = /\/watch(\b|\/|\?)/.test(t.url || '');
        if (!isPage || !isWatch) continue;
        if (ownedTargets.has(t.targetId)) continue; // never touch our own in-flight tabs
        await Promise.resolve(
          browser.send('Target.closeTarget', { targetId: t.targetId }),
        ).catch(() => {});
        closed += 1;
      }
    } catch (err) {
      logger(`closeStaleWatchTabs failed: ${err?.message || err}`);
    }
    if (closed) logger(`closed ${closed} stale watch tab(s) left by a prior run`);
    return closed;
  }

  function stats() {
    return {
      createTargetCalls,
      attachCalls,
      dialogsAccepted,
      openTabCount: ownedTargets.size,
      attachedTargetCount: sessionByTarget.size,
    };
  }

  return {
    extId,
    navTimeoutMs,
    attachOnce,
    registerDialogHandler,
    wakeServiceWorker,
    openLectureTab,
    closeTab,
    closeAllTabs,
    closeStaleWatchTabs,
    runCapture,
    stats,
  };
}
