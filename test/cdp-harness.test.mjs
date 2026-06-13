// test/cdp-harness.test.mjs — unit tests for the Key_Harvester CDP harness.
//
// Feature: pi-scrape-pipeline — Task 10.1. These drive the harness with a FAKE
// Browser-like client (no real Opera/CDP) to cover the operational quirks the
// harness encodes: fresh-tab-per-lecture, dialog auto-accept, single-attach
// guard, the global watchdog, MV3 service-worker wake, and tab cleanup.
//
// _Requirements: 1.3, 14.3_

import { describe, it, expect } from 'vitest';

import {
  createCdpHarness,
  WatchdogTimeoutError,
  DEFAULT_EXT_ID,
} from '../pi-harvester/cdp-harness.mjs';

/**
 * Minimal in-memory CDP client that mimics the bits of cdp-debug.mjs's Browser
 * the harness relies on — including the real-world quirk that a second
 * Target.attachToTarget on the same target throws a `sessionId` protocol error.
 */
class FakeBrowser {
  constructor() {
    this.calls = [];
    this.listeners = [];
    this._targets = [];
    this._nextTarget = 1;
    this._nextSession = 1;
    this.attachCount = new Map();
  }

  send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Target.createTarget') {
      const targetId = `T${this._nextTarget++}`;
      this._targets.push({ targetId, type: 'page', url: params.url });
      // Opening the panel page wakes the (previously absent) MV3 service worker.
      if (typeof params.url === 'string' && params.url.includes('/panel/panel.html')) {
        const host = params.url.split('//')[1]?.split('/')[0] ?? '';
        this._targets.push({
          targetId: `SW${this._nextTarget++}`,
          type: 'service_worker',
          url: `chrome-extension://${host}/background.js`,
        });
      }
      return Promise.resolve({ targetId });
    }
    if (method === 'Target.closeTarget') {
      this._targets = this._targets.filter((t) => t.targetId !== params.targetId);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  }

  attach(targetId) {
    const n = (this.attachCount.get(targetId) || 0) + 1;
    this.attachCount.set(targetId, n);
    if (n > 1) {
      // Mirror CDP: re-attaching the same target is a protocol error.
      return Promise.reject(
        new Error(`{"code":-32000,"message":"sessionId for target ${targetId} already attached"}`),
      );
    }
    return Promise.resolve(`S${this._nextSession++}`);
  }

  async targets() {
    return this._targets.slice();
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  emit(msg) {
    for (const l of this.listeners) l(msg);
  }

  close() {}

  callsOf(method) {
    return this.calls.filter((c) => c.method === method);
  }
}

describe('createCdpHarness — construction', () => {
  it('requires a Browser-like client', () => {
    expect(() => createCdpHarness({})).toThrow(/Browser-like client/);
  });

  it('defaults to the WidevineProxy2 dev extension id', () => {
    const h = createCdpHarness({ browser: new FakeBrowser() });
    expect(h.extId).toBe(DEFAULT_EXT_ID);
  });
});

describe('fresh tab per lecture (never reuse a watch tab)', () => {
  it('creates a brand-new target for each capture and never reuses one', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    const seen = [];
    await harness.runCapture('https://www.pw.live/watch/?childId=A', async (ctx) => {
      seen.push(ctx.targetId);
      return 'a';
    });
    await harness.runCapture('https://www.pw.live/watch/?childId=B', async (ctx) => {
      seen.push(ctx.targetId);
      return 'b';
    });

    const created = browser.callsOf('Target.createTarget');
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.params.url)).toEqual([
      'https://www.pw.live/watch/?childId=A',
      'https://www.pw.live/watch/?childId=B',
    ]);
    // Two distinct tabs — the second lecture never reuses the first tab.
    expect(seen[0]).not.toBe(seen[1]);
    expect(new Set(seen).size).toBe(2);
  });
});

describe('javascript dialog auto-accept', () => {
  it('enables Page events and registers a handler for the lecture session', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });
    const { sessionId } = await harness.openLectureTab('https://www.pw.live/watch/?childId=A');

    const pageEnable = browser
      .callsOf('Page.enable')
      .find((c) => c.sessionId === sessionId);
    expect(pageEnable).toBeTruthy();
  });

  it('answers Page.javascriptDialogOpening with accept:true for a registered session', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });
    const { sessionId } = await harness.openLectureTab('https://www.pw.live/watch/?childId=A');

    browser.emit({
      method: 'Page.javascriptDialogOpening',
      sessionId,
      params: { type: 'beforeunload', message: 'Leave site?' },
    });
    await Promise.resolve(); // let the async handler flush

    const handled = browser
      .callsOf('Page.handleJavaScriptDialog')
      .filter((c) => c.sessionId === sessionId);
    expect(handled).toHaveLength(1);
    expect(handled[0].params).toEqual({ accept: true });
    expect(harness.stats().dialogsAccepted).toBe(1);
  });

  it('ignores dialogs for sessions the harness does not own', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });
    await harness.openLectureTab('https://www.pw.live/watch/?childId=A');

    browser.emit({
      method: 'Page.javascriptDialogOpening',
      sessionId: 'SOMEONE-ELSE',
      params: { type: 'alert' },
    });
    await Promise.resolve();

    expect(browser.callsOf('Page.handleJavaScriptDialog')).toHaveLength(0);
    expect(harness.stats().dialogsAccepted).toBe(0);
  });
});

describe('single-attach guard', () => {
  it('attaches a target exactly once and reuses the cached sessionId', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    const first = await harness.attachOnce('TX');
    const second = await harness.attachOnce('TX');

    expect(first).toBe(second);
    expect(browser.attachCount.get('TX')).toBe(1);
  });

  it('does not re-attach when a capture re-requests its own session', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    await harness.runCapture('https://www.pw.live/watch/?childId=A', async (ctx) => {
      // The capture loop re-requesting its session must not trigger a 2nd attach.
      const again = await harness.attachOnce(ctx.targetId);
      expect(again).toBe(ctx.sessionId);
    });

    // Exactly one attach happened for the single lecture target.
    expect(harness.stats().attachCalls).toBe(1);
  });

  it('the fake mirrors CDP: a raw double attach is a protocol error', async () => {
    const browser = new FakeBrowser();
    await browser.attach('T1');
    await expect(browser.attach('T1')).rejects.toThrow(/already attached/);
  });
});

describe('global watchdog', () => {
  it('force-aborts a stuck capture and closes its tab', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    let openedTargetId;
    const stuck = harness.runCapture(
      'https://www.pw.live/watch/?childId=STUCK',
      async (ctx) => {
        openedTargetId = ctx.targetId;
        return new Promise(() => {}); // never resolves — simulates a wedged capture
      },
      { timeoutMs: 20 },
    );

    await expect(stuck).rejects.toBeInstanceOf(WatchdogTimeoutError);

    // The wedged lecture's tab was closed so the slot is freed.
    const closed = browser.callsOf('Target.closeTarget');
    expect(closed.some((c) => c.params.targetId === openedTargetId)).toBe(true);
    expect(harness.stats().openTabCount).toBe(0);
  });

  it('does not fire the watchdog when the capture completes in time', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    const result = await harness.runCapture(
      'https://www.pw.live/watch/?childId=FAST',
      async () => 'captured',
      { timeoutMs: 1000 },
    );
    expect(result).toBe('captured');
  });
});

describe('tab cleanup', () => {
  it('closes the fresh tab after a successful capture', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    let openedTargetId;
    const out = await harness.runCapture('https://www.pw.live/watch/?childId=A', async (ctx) => {
      openedTargetId = ctx.targetId;
      return 'done';
    });

    expect(out).toBe('done');
    const closed = browser.callsOf('Target.closeTarget');
    expect(closed.some((c) => c.params.targetId === openedTargetId)).toBe(true);
    expect(harness.stats().openTabCount).toBe(0);
  });

  it('closes the tab even when the capture throws', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });

    let openedTargetId;
    await expect(
      harness.runCapture('https://www.pw.live/watch/?childId=ERR', async (ctx) => {
        openedTargetId = ctx.targetId;
        throw new Error('capture blew up');
      }),
    ).rejects.toThrow('capture blew up');

    expect(browser.callsOf('Target.closeTarget').some((c) => c.params.targetId === openedTargetId)).toBe(true);
    expect(harness.stats().openTabCount).toBe(0);
  });
});

describe('stale watch-tab sweep (orphan cleanup after a killed run)', () => {
  it('closes pre-existing watch page tabs the harness does not own', async () => {
    const browser = new FakeBrowser();
    // Two leftover watch tabs from a prior (killed) run, plus an unrelated page.
    browser._targets.push({ targetId: 'W1', type: 'page', url: 'https://www.pw.live/watch/?childId=A' });
    browser._targets.push({ targetId: 'W2', type: 'page', url: 'https://www.pw.live/watch/?childId=B' });
    browser._targets.push({ targetId: 'P1', type: 'page', url: 'https://www.pw.live/dashboard' });
    const harness = createCdpHarness({ browser });

    const closed = await harness.closeStaleWatchTabs();

    expect(closed).toBe(2);
    const closedIds = browser.callsOf('Target.closeTarget').map((c) => c.params.targetId);
    expect(closedIds).toContain('W1');
    expect(closedIds).toContain('W2');
    expect(closedIds).not.toContain('P1');
  });

  it('never closes a watch tab the harness currently owns', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser });
    // The harness opens (owns) a watch tab; a stale sweep must leave it alone.
    const tab = await harness.openLectureTab('https://www.pw.live/watch/?childId=OWNED');
    const closedBefore = browser.callsOf('Target.closeTarget').length;

    const closed = await harness.closeStaleWatchTabs();

    expect(closed).toBe(0);
    expect(browser.callsOf('Target.closeTarget').length).toBe(closedBefore);
    expect(harness.stats().openTabCount).toBeGreaterThanOrEqual(1);
    expect(tab.targetId).toBeTruthy();
  });
});

describe('MV3 service-worker wake', () => {
  it('opens the panel page to wake an idle service worker, then attaches to it', async () => {
    const browser = new FakeBrowser();
    const harness = createCdpHarness({ browser, swWakeDelayMs: 0 });

    const result = await harness.wakeServiceWorker();

    const panelCreate = browser
      .callsOf('Target.createTarget')
      .find((c) => c.params.url.includes('/panel/panel.html'));
    expect(panelCreate).toBeTruthy();
    expect(panelCreate.params.url).toBe(`chrome-extension://${DEFAULT_EXT_ID}/panel/panel.html`);
    expect(result.woke).toBe(true);
    expect(result.sessionId).toBeTruthy();
  });

  it('reuses an already-awake service worker without opening the panel', async () => {
    const browser = new FakeBrowser();
    browser._targets.push({
      targetId: 'SW-LIVE',
      type: 'service_worker',
      url: `chrome-extension://${DEFAULT_EXT_ID}/background.js`,
    });
    const harness = createCdpHarness({ browser });

    const result = await harness.wakeServiceWorker();
    expect(result.woke).toBe(false);
    expect(result.targetId).toBe('SW-LIVE');
    expect(browser.callsOf('Target.createTarget')).toHaveLength(0);
  });
});
