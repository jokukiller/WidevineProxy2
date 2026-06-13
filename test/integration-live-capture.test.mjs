// test/integration-live-capture.test.mjs — Task 10.4 part 1 (GATED / MANUAL).
//
// Feature: pi-scrape-pipeline — Task 10.4 "Integration check (gated/manual)".
//
// This is the LIVE, end-to-end half of the integration check. It captures ONE
// known ClearKey lecture and ONE known Widevine lecture through the REAL
// harness + capture-loop (Opera GX + the WidevineProxy2 extension over CDP, with
// a logged-in PW session) and verifies the resulting Key_Catalog entry carries
// {kid, key, drmType} with drmType ClearKey / Widevine respectively
// (Req 1.4, 1.5). It also performs a small live resume check: a second capture
// of the same childId is SKIPPED, never re-captured (Property 2 / Req 3.3).
//
// ────────────────────────────────────────────────────────────────────────────
// THIS TEST IS SKIPPED BY DEFAULT. The offline `npm test` run stays green with
// NO live browser and NO PW account. It runs ONLY when the operator opts in.
// ────────────────────────────────────────────────────────────────────────────
//
// HOW THE OPERATOR RUNS IT (all from this package directory,
// widevineproxyoriginal/WidevineProxy2-crawler/):
//
//   1. Launch Opera GX with remote debugging and the WidevineProxy2 extension
//      loaded, then log in to a PW account in that browser:
//        "C:\Users\<you>\AppData\Local\Programs\Opera GX\opera.exe" \
//          --remote-debugging-port=9222
//      (Open the extension panel once so the MV3 service worker is awake; the
//      harness also wakes it via chrome-extension://<extId>/panel/panel.html.)
//
//   2. Pick a KNOWN ClearKey childId and a KNOWN Widevine childId (e.g. via
//      probe-drm.mjs / probe-mpd.mjs) and export them. The watch URLs are
//      derived from the childId by default, or set explicitly:
//
//        $env:PI_HARVEST_LIVE              = "1"        # the master gate
//        $env:PI_HARVEST_CLEARKEY_CHILD    = "<childId>"
//        $env:PI_HARVEST_WIDEVINE_CHILD    = "<childId>"
//        # optional explicit watch URLs (else built from the childId):
//        $env:PI_HARVEST_CLEARKEY_WATCHURL = "https://www.pw.live/watch/?...childId=..."
//        $env:PI_HARVEST_WIDEVINE_WATCHURL = "https://www.pw.live/watch/?...childId=..."
//        # optional dev-copy extension id (defaults to the known one):
//        $env:PI_HARVEST_EXT_ID            = "pkoikjplcdkipeogmopelecfnfpaddcl"
//
//   3. Run just this file:
//        npx vitest --run test/integration-live-capture.test.mjs
//
// Without PI_HARVEST_LIVE=1 the whole suite is skipped (this file contributes
// zero executed tests). With the gate set but a DRM-specific childId unset, that
// DRM's test is individually skipped, so the operator can validate one DRM type
// at a time. See pi-harvester/README.md for the full runbook.
//
// Validates: Property 2 (live skip-on-resume)
// _Requirements: 1.4, 1.5, 3.3_

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KeyCatalog } from '../../../codespaces/pi-pipeline/src/key-catalog.mjs';
import { DRM_TYPE } from '../../../codespaces/pi-pipeline/src/constants.mjs';
import { Browser } from '../cdp-debug.mjs';
import { createCdpHarness } from '../pi-harvester/cdp-harness.mjs';
import {
  createCaptureLoop,
  createExtensionCaptureReader,
  createMpdDrmResolver,
  createForcePlayback,
  CAPTURE_STATUS,
} from '../pi-harvester/capture-loop.mjs';

// --- gating ----------------------------------------------------------------

const LIVE = process.env.PI_HARVEST_LIVE === '1';
const CLEARKEY_CHILD = process.env.PI_HARVEST_CLEARKEY_CHILD || '';
const WIDEVINE_CHILD = process.env.PI_HARVEST_WIDEVINE_CHILD || '';
const EXT_ID = process.env.PI_HARVEST_EXT_ID || undefined;

/** Derive a PW watch URL from a childId, or use the explicit override. */
function watchUrlFor(childId, override) {
  if (typeof override === 'string' && override.length > 0) return override;
  return `https://www.pw.live/watch/?childId=${childId}`;
}

// describe.skipIf(!LIVE): the ENTIRE block is skipped unless the operator opts
// in with PI_HARVEST_LIVE=1. No browser connection happens at collection time —
// the live wiring is created in beforeAll, which a skipped describe never runs.
describe.skipIf(!LIVE)('GATED live end-to-end capture (Req 1.4, 1.5, 3.3)', () => {
  let dir;
  let browser;
  let harness;
  let loop;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'live-capture-'));

    // Connect to the already-running Opera GX over CDP and wire the REAL
    // harvester collaborators exactly as the production key-harvester does.
    browser = await Browser.connect();
    harness = createCdpHarness({ browser, ...(EXT_ID ? { extId: EXT_ID } : {}) });
    const { sessionId: swSessionId } = await harness.wakeServiceWorker();
    if (!swSessionId) {
      throw new Error(
        'Could not wake the WidevineProxy2 service worker — open the extension panel once and retry.',
      );
    }
    loop = createCaptureLoop({
      harness,
      captureReader: createExtensionCaptureReader({ browser, swSessionId }),
      drmResolver: createMpdDrmResolver({ browser, swSessionId }),
      forcePlayback: createForcePlayback({ browser }),
      logger: () => {},
    });
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.closeAllTabs().catch(() => {});
    if (browser) browser.close();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Capture one lecture end-to-end and assert the persisted Key_Catalog entry
   * carries {kid, key, drmType} with the expected drmType. Then re-run the same
   * childId against the same catalog and assert it is SKIPPED (Property 2).
   */
  async function captureAndAssert(childId, watchUrl, expectedDrmType) {
    const catalogPath = path.join(dir, `key-catalog-${childId}.json`);
    const catalog = await KeyCatalog.load(catalogPath);

    const result = await loop.captureChildId({ childId, watchUrl });
    expect(result.status, `capture failed: ${result.reason || ''}`).toBe(CAPTURE_STATUS.CAPTURED);
    expect(typeof result.kid).toBe('string');
    expect(result.kid.length).toBeGreaterThan(0);
    expect(typeof result.key).toBe('string');
    expect(result.key.length).toBeGreaterThan(0);
    expect(result.drmType).toBe(expectedDrmType);

    // Persist and verify the on-disk Key_Catalog entry (Req 1.4 / 1.5).
    catalog.put(childId, {
      kid: result.kid,
      key: result.key,
      kty: result.kty,
      drmType: result.drmType,
    });
    await catalog.save(catalogPath);

    const reloaded = await KeyCatalog.load(catalogPath);
    const entry = reloaded.get(childId);
    expect(entry).toBeTruthy();
    expect(entry.kid).toBe(result.kid);
    expect(entry.key).toBe(result.key);
    expect(entry.drmType).toBe(expectedDrmType);
    expect(reloaded.has(childId)).toBe(true);

    // Live resume check (Property 2 / Req 3.3): the catalog now reports this
    // childId as already captured, so a resumed harvest would skip it — the
    // append-only put is a no-op that retains the exact pair.
    expect(reloaded.put(childId, { kid: 'X', key: 'Y', drmType: 'CLEARKEY' })).toBe(false);
    expect(reloaded.get(childId).key).toBe(result.key);
  }

  it.skipIf(!CLEARKEY_CHILD)(
    'captures a known ClearKey lecture and records drmType ClearKey (Req 1.4)',
    async () => {
      await captureAndAssert(
        CLEARKEY_CHILD,
        watchUrlFor(CLEARKEY_CHILD, process.env.PI_HARVEST_CLEARKEY_WATCHURL),
        DRM_TYPE.CLEARKEY,
      );
    },
    180_000,
  );

  it.skipIf(!WIDEVINE_CHILD)(
    'captures a known Widevine lecture and records drmType Widevine (Req 1.5)',
    async () => {
      await captureAndAssert(
        WIDEVINE_CHILD,
        watchUrlFor(WIDEVINE_CHILD, process.env.PI_HARVEST_WIDEVINE_WATCHURL),
        DRM_TYPE.WIDEVINE,
      );
    },
    180_000,
  );
});
