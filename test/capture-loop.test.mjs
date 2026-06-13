// test/capture-loop.test.mjs — unit tests for the Key_Harvester capture loop.
//
// Feature: pi-scrape-pipeline — Task 10.2. These drive the capture loop with the
// REAL 10.1 CDP harness over a FAKE Browser-like client plus injected fakes for
// the extension capture reader, the drm resolver / mpd source, and the playback
// nudge — so retry counting, drmType classification, the capture-vs-fail
// decision, and navigation-timeout handling are all covered with NO real
// browser.
//
// _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2.2, 2.4, 2.5, 2.6_

import { describe, it, expect } from 'vitest';

import { createCdpHarness } from '../pi-harvester/cdp-harness.mjs';
import {
  createCaptureLoop,
  classifyDrmType,
  drmTypeForSystemId,
  CAPTURE_STATUS,
  FAILURE_REASON,
} from '../pi-harvester/capture-loop.mjs';
import { DRM_SYSTEM_IDS, DRM_TYPE } from '../../../codespaces/pi-pipeline/src/constants.mjs';

/** Minimal in-memory CDP client (mirrors the harness's own test fake). */
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
    return Promise.resolve(`S${this._nextSession++}`);
  }

  async targets() {
    return this._targets.slice();
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  close() {}

  callsOf(method) {
    return this.calls.filter((c) => c.method === method);
  }
}

const CLEARKEY_PAIR = {
  kid: 'a199e3ccf9d614a6ffe7f749895761c6',
  key: 'd01c5e84e4cd6b4b2de6831f2edc61d7',
  kty: 'oct',
  type: 'CLEARKEY',
  pssh_data: 'eyJraWRzIjpbImFiYyJdfQ==',
};

const WIDEVINE_PAIR = {
  kid: 'b2c3d4e5f60718293a4b5c6d7e8f9001',
  key: '112233445566778899aabbccddeeff00',
  kty: 'oct',
  type: 'WIDEVINE',
  pssh_data: 'AAAANHBzc2gB',
};

const CLEARKEY_MPD = `<MPD><ContentProtection schemeIdUri="urn:uuid:${DRM_SYSTEM_IDS.CLEARKEY}"><cenc:pssh>x</cenc:pssh></ContentProtection></MPD>`;
const WIDEVINE_MPD = `<MPD><ContentProtection schemeIdUri="urn:uuid:${DRM_SYSTEM_IDS.WIDEVINE}"><cenc:pssh>y</cenc:pssh></ContentProtection></MPD>`;

const noopSleep = () => Promise.resolve();

function buildLoop(overrides = {}) {
  const browser = new FakeBrowser();
  const harness = createCdpHarness({ browser, swWakeDelayMs: 0 });
  const loop = createCaptureLoop({
    harness,
    captureReader: { read: async () => null },
    forcePlayback: async () => true,
    sleep: noopSleep,
    pollAttempts: 3,
    maxRetries: 3,
    navTimeoutMs: 1000,
    ...overrides,
  });
  return { browser, harness, loop };
}

describe('drmType classification (pure)', () => {
  it('maps the ClearKey systemId to CLEARKEY', () => {
    expect(drmTypeForSystemId(DRM_SYSTEM_IDS.CLEARKEY)).toBe(DRM_TYPE.CLEARKEY);
    expect(drmTypeForSystemId(`urn:uuid:${DRM_SYSTEM_IDS.CLEARKEY}`)).toBe(DRM_TYPE.CLEARKEY);
  });

  it('maps the Widevine systemId to WIDEVINE', () => {
    expect(drmTypeForSystemId(DRM_SYSTEM_IDS.WIDEVINE)).toBe(DRM_TYPE.WIDEVINE);
    expect(drmTypeForSystemId(`urn:uuid:${DRM_SYSTEM_IDS.WIDEVINE.toUpperCase()}`)).toBe(
      DRM_TYPE.WIDEVINE,
    );
  });

  it('returns null for unknown / empty systemIds', () => {
    expect(drmTypeForSystemId('9a04f079-9840-4286-ab92-e65be0885f95')).toBeNull(); // PlayReady
    expect(drmTypeForSystemId('')).toBeNull();
    expect(drmTypeForSystemId(undefined)).toBeNull();
  });

  it('classifies a DASH manifest by its ContentProtection systemId', () => {
    expect(classifyDrmType(CLEARKEY_MPD)).toBe(DRM_TYPE.CLEARKEY);
    expect(classifyDrmType(WIDEVINE_MPD)).toBe(DRM_TYPE.WIDEVINE);
    expect(classifyDrmType('<MPD></MPD>')).toBeNull();
    expect(classifyDrmType(null)).toBeNull();
  });

  it('prefers Widevine when a manifest declares both systemIds', () => {
    const both = `<MPD>
      <ContentProtection schemeIdUri="urn:uuid:${DRM_SYSTEM_IDS.CLEARKEY}"/>
      <ContentProtection schemeIdUri="urn:uuid:${DRM_SYSTEM_IDS.WIDEVINE}"/>
    </MPD>`;
    expect(classifyDrmType(both)).toBe(DRM_TYPE.WIDEVINE);
  });
});

describe('successful capture', () => {
  it('captures a ClearKey lecture and records {kid,key,drmType} (Req 1.4)', async () => {
    const { loop } = buildLoop({
      captureReader: { read: async () => ({ ...CLEARKEY_PAIR }) },
      mpdSource: async () => CLEARKEY_MPD,
    });

    const result = await loop.captureChildId({
      childId: '699fe7fb0e6503b008feaffb',
      watchUrl: 'https://www.pw.live/watch/?childId=699fe7fb0e6503b008feaffb',
    });

    expect(result.status).toBe(CAPTURE_STATUS.CAPTURED);
    expect(result.kid).toBe(CLEARKEY_PAIR.kid);
    expect(result.key).toBe(CLEARKEY_PAIR.key);
    expect(result.kty).toBe('oct');
    expect(result.drmType).toBe(DRM_TYPE.CLEARKEY);
    expect(result.pssh_data).toBe(CLEARKEY_PAIR.pssh_data);
    expect(result.attempts).toBe(1);
  });

  it('captures a Widevine lecture and records drmType WIDEVINE (Req 1.5)', async () => {
    const { loop } = buildLoop({
      captureReader: { read: async () => ({ ...WIDEVINE_PAIR }) },
      mpdSource: async () => WIDEVINE_MPD,
    });

    const result = await loop.captureChildId({
      childId: 'wv-child',
      watchUrl: 'https://www.pw.live/watch/?childId=wv-child',
    });

    expect(result.status).toBe(CAPTURE_STATUS.CAPTURED);
    expect(result.drmType).toBe(DRM_TYPE.WIDEVINE);
    expect(result.kid).toBe(WIDEVINE_PAIR.kid);
    expect(result.key).toBe(WIDEVINE_PAIR.key);
  });

  it('falls back to the captured log type when no manifest source is available', async () => {
    const { loop } = buildLoop({
      captureReader: { read: async () => ({ ...CLEARKEY_PAIR }) },
      // no mpdSource / drmResolver
    });
    const result = await loop.captureChildId({
      childId: 'c',
      watchUrl: 'https://www.pw.live/watch/?childId=c',
    });
    expect(result.status).toBe(CAPTURE_STATUS.CAPTURED);
    expect(result.drmType).toBe(DRM_TYPE.CLEARKEY);
  });

  it('manifest classification takes precedence over the captured log type', async () => {
    // Captured log says CLEARKEY but the manifest declares Widevine → trust manifest.
    const { loop } = buildLoop({
      captureReader: { read: async () => ({ ...CLEARKEY_PAIR }) },
      drmResolver: async () => DRM_TYPE.WIDEVINE,
    });
    const result = await loop.captureChildId({
      childId: 'c',
      watchUrl: 'https://www.pw.live/watch/?childId=c',
    });
    expect(result.drmType).toBe(DRM_TYPE.WIDEVINE);
  });

  it('yields at most one {kid,key} even when the reader could see many', async () => {
    const { loop } = buildLoop({
      captureReader: { read: async () => ({ ...CLEARKEY_PAIR }) },
      mpdSource: async () => CLEARKEY_MPD,
    });
    const result = await loop.captureChildId({
      childId: 'c',
      watchUrl: 'https://www.pw.live/watch/?childId=c',
    });
    expect(typeof result.kid).toBe('string');
    expect(typeof result.key).toBe('string');
    expect(Array.isArray(result.key)).toBe(false);
  });

  it('succeeds on a later poll within the same attempt without retrying', async () => {
    let polls = 0;
    const { browser, loop } = buildLoop({
      captureReader: {
        read: async () => {
          polls += 1;
          return polls >= 3 ? { ...CLEARKEY_PAIR } : null;
        },
      },
      mpdSource: async () => CLEARKEY_MPD,
      pollAttempts: 5,
    });

    const result = await loop.captureChildId({
      childId: 'c',
      watchUrl: 'https://www.pw.live/watch/?childId=c',
    });
    expect(result.status).toBe(CAPTURE_STATUS.CAPTURED);
    expect(result.attempts).toBe(1); // single navigation, polled until the key appeared
    expect(browser.callsOf('Target.createTarget')).toHaveLength(1);
  });
});

describe('navigation timeout → failed (Req 1.7)', () => {
  it('records navigation-timeout and writes no key when playback never completes', async () => {
    const { loop } = buildLoop({
      // playback hangs forever → the harness watchdog force-aborts the attempt
      forcePlayback: () => new Promise(() => {}),
      captureReader: { read: async () => ({ ...CLEARKEY_PAIR }) },
      navTimeoutMs: 20,
    });

    const result = await loop.captureChildId({
      childId: 'stuck',
      watchUrl: 'https://www.pw.live/watch/?childId=stuck',
    });

    expect(result.status).toBe(CAPTURE_STATUS.FAILED);
    expect(result.reason).toBe(FAILURE_REASON.NAVIGATION_TIMEOUT);
    expect(result.attempts).toBe(1);
    // Failure must not carry a captured pair (Req 2.4, 2.5, 2.6).
    expect(result.kid).toBeUndefined();
    expect(result.key).toBeUndefined();
  });
});

describe('no usable key after 3 retries → failed (Req 1.8)', () => {
  it('retries up to MAX_RETRIES and fails with no-usable-key', async () => {
    let reads = 0;
    const { browser, loop } = buildLoop({
      captureReader: {
        read: async () => {
          reads += 1;
          return null; // extension never produced a pair
        },
      },
      pollAttempts: 2,
      maxRetries: 3,
    });

    const result = await loop.captureChildId({
      childId: 'nokey',
      watchUrl: 'https://www.pw.live/watch/?childId=nokey',
    });

    expect(result.status).toBe(CAPTURE_STATUS.FAILED);
    expect(result.reason).toBe(FAILURE_REASON.NO_USABLE_KEY);
    expect(result.attempts).toBe(3);
    expect(result.kid).toBeUndefined();
    expect(result.key).toBeUndefined();
    // Three fresh-tab attempts were made (one per retry).
    expect(browser.callsOf('Target.createTarget')).toHaveLength(3);
    expect(reads).toBe(6); // 2 polls × 3 attempts
  });
});

describe('failure never yields a captured pair (Req 2.4, 2.5, 2.6)', () => {
  it('a missing childId/watchUrl fails without a key', async () => {
    const { loop } = buildLoop();
    const result = await loop.captureChildId({ childId: '', watchUrl: '' });
    expect(result.status).toBe(CAPTURE_STATUS.FAILED);
    expect(result.kid).toBeUndefined();
    expect(result.key).toBeUndefined();
  });

  it('a transient capture error is retried, then fails without a key', async () => {
    let attempt = 0;
    const { loop } = buildLoop({
      // Throw a non-watchdog error on every attempt.
      captureReader: {
        read: async () => {
          attempt += 1;
          throw new Error('boom');
        },
      },
      pollAttempts: 1,
      maxRetries: 3,
    });

    const result = await loop.captureChildId({
      childId: 'err',
      watchUrl: 'https://www.pw.live/watch/?childId=err',
    });
    expect(result.status).toBe(CAPTURE_STATUS.FAILED);
    expect(result.reason).toBe(FAILURE_REASON.CAPTURE_ERROR);
    expect(result.attempts).toBe(3);
    expect(result.kid).toBeUndefined();
    expect(attempt).toBe(3);
  });
});
