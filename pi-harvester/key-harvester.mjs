// pi-harvester/key-harvester.mjs — LOCAL entry point for the Key_Harvester.
//
// Feature: pi-scrape-pipeline — Task 1 scaffold (capture loop lands in Task 10).
//
// This is the ONLY component permitted to run on the operator's local machine
// (Req 14.1): it is the browser + CDM half. It drives Opera GX + the
// WidevineProxy2 extension over CDP (reusing the sibling `cdp-debug.mjs` client
// and this package's existing `ws` dependency — no new browser deps) to capture
// each unique childId's content key once into the permanent Key_Catalog.
//
// The remote half (Manifest_Resolver, Batch_Controller, token refresh, all PW
// on-demand calls) lives under codespaces/pi-pipeline/ and MUST NOT run here.
//
// Shared, single-source constants are imported from the pi-pipeline package so
// both halves agree on the PW contract, DRM systemIds, and timeouts/thresholds.
//
// CLI (full behaviour implemented in Task 10):
//   node pi-harvester/key-harvester.mjs \
//     --assets ../../crawler-output/pi-assets.json \
//     --placements ../../crawler-output/pi-placements.json \
//     --out ./key-catalog.json [--subject "<name>"] [--concurrency N] [--ext <extId>]
//
// Requirements: 14.1, 14.2

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  NAV_TIMEOUT_MS,
  MAX_RETRIES,
  DRM_SYSTEM_IDS,
} from '../../../codespaces/pi-pipeline/src/constants.mjs';
import { KeyCatalog } from '../../../codespaces/pi-pipeline/src/key-catalog.mjs';
import { Browser, evalIn } from '../cdp-debug.mjs';
import { createCdpHarness } from './cdp-harness.mjs';
import {
  createCaptureLoop,
  createExtensionCaptureReader,
  createMpdDrmResolver,
  createForcePlayback,
} from './capture-loop.mjs';
import { buildWorkSet, createHarvestRun } from './harvest-run.mjs';

/** Parse `--flag value` / `--flag` CLI args into a plain object. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const USAGE = `Key_Harvester (local, browser + CDM)

Usage:
  node pi-harvester/key-harvester.mjs --assets <pi-assets.json> --placements <pi-placements.json> --out <key-catalog.json>
    [--subject "<name>"]   restrict to one subject (subject-priority harvest)
    [--concurrency N]      parallel capture tabs (default 1)
    [--ext <extId>]        WidevineProxy2 extension id (default pkoikjplcdkipeogmopelecfnfpaddcl)
    [--heartbeat-ms N]     progress heartbeat interval (default 30000)

Notes:
  - Requires Opera GX launched with --remote-debugging-port=9222 (see cdp-debug.mjs).
  - This component is LOCAL-ONLY (Req 14.1). The remote pipeline lives in codespaces/pi-pipeline/.
  - The run is resumable: an existing --out catalog is loaded and only non-captured
    childIds are re-attempted; a captured childId is never re-captured.
`;

/** Read + JSON.parse a catalog input file. */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * Prepare the WidevineProxy2 service worker for an unattended harvest.
 *
 *  - Forces the master capture toggle ON (`chrome.storage.sync.enabled`). When
 *    it is false the SW's RESPONSE handler short-circuits BEFORE parseClearKey,
 *    so NO key is ever stored — the silent "0 captures, all navigation-timeout"
 *    failure (HANDOFF §bug-4). Aborting the run when it can't be enabled is far
 *    better than burning hours capturing nothing.
 *  - Drops the crawler snapshot/history blobs from `chrome.storage.local`. These
 *    can exceed 140 MB; with them present every capture read (`storage.get(null)`
 *    in the capture reader) took ~6 s, starving the poll loop. Removing them
 *    drops the read to ~0 ms.
 *
 * Returns the SW's post-write view of the toggle for the startup log.
 */
export async function ensureExtensionReady(browser, swSessionId) {
  const expr = `(async () => {
    await chrome.storage.sync.set({ enabled: true });
    await chrome.storage.local.remove(['pwCrawlSnapshot', 'pwCrawlHistory', 'pwCrawlState']);
    const sync = await chrome.storage.sync.get(['enabled']);
    return JSON.stringify({ enabled: sync.enabled === true });
  })()`;
  try {
    const raw = await evalIn(browser, swSessionId, expr);
    return raw ? JSON.parse(raw) : { enabled: null };
  } catch (err) {
    return { enabled: null, error: String(err?.message || err) };
  }
}

/** Format a heartbeat snapshot into a single operator-readable log line. */
function formatHeartbeat(s) {
  const eta = s.etaMs == null ? '?' : `${Math.round(s.etaMs / 1000)}s`;
  const cur = s.current.length ? s.current.join(',') : '-';
  return (
    `[harvest] captured=${s.captured} pending=${s.pending} failed=${s.failed} ` +
    `skipped=${s.skipped}/${s.attempted} eta=${eta} current=${cur}`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.assets || !args.placements || !args.out) {
    process.stdout.write(USAGE);
    process.stdout.write(
      `\n(nav budget ${NAV_TIMEOUT_MS}ms, max retries ${MAX_RETRIES}, ` +
        `DRM systemIds: ClearKey ${DRM_SYSTEM_IDS.CLEARKEY}, Widevine ${DRM_SYSTEM_IDS.WIDEVINE})\n`,
    );
    return 0;
  }

  const subject = typeof args.subject === 'string' ? args.subject : undefined;
  const concurrency = args.concurrency ? Math.max(1, parseInt(args.concurrency, 10) || 1) : 1;
  const heartbeatIntervalMs = args['heartbeat-ms']
    ? Math.max(1000, parseInt(args['heartbeat-ms'], 10) || 30_000)
    : 30_000;
  const extId = typeof args.ext === 'string' ? args.ext : undefined;

  // Load inputs and build the deduped, subject-ordered work set (Req 1.1, 4.3).
  const [assets, placements] = await Promise.all([readJson(args.assets), readJson(args.placements)]);
  const workItems = buildWorkSet({ assets, placements, subject });
  process.stdout.write(`[harvest] work set: ${workItems.length} unique childIds${subject ? ` (subject="${subject}")` : ''}\n`);

  // Load the existing catalog to resume (Req 3.2). Never re-capture a captured id.
  const catalog = await KeyCatalog.load(args.out);

  // Wire the live CDP collaborators (Opera GX + WidevineProxy2 over CDP).
  const browser = await Browser.connect();
  const harness = createCdpHarness({ browser, ...(extId ? { extId } : {}) });
  const { sessionId: swSessionId } = await harness.wakeServiceWorker();
  if (!swSessionId) {
    browser.close();
    throw new Error('Could not wake the WidevineProxy2 service worker (open the extension once and retry).');
  }

  // Force the capture toggle on and clear the giant snapshot blobs BEFORE any
  // capture runs (HANDOFF §bug-4). Abort loudly if the toggle won't stick — a
  // disabled extension produces a silent 0-capture run.
  const ready = await ensureExtensionReady(browser, swSessionId);
  process.stdout.write(`[harvest] extension capture toggle enabled=${ready.enabled}\n`);
  if (ready.enabled !== true) {
    browser.close();
    throw new Error(
      'Could not enable the WidevineProxy2 capture toggle (chrome.storage.sync.enabled). ' +
        'Aborting to avoid a 0-capture run.' +
        (ready.error ? ` (${ready.error})` : ''),
    );
  }

  // Close any watch tabs left open by a prior hard-killed run (a stop/crash
  // skips the harness tab cleanup, orphaning in-flight tabs that keep decoding
  // video and lag the machine). A fresh run owns none, so this is safe.
  await harness.closeStaleWatchTabs();

  const loop = createCaptureLoop({
    harness,
    captureReader: createExtensionCaptureReader({ browser, swSessionId }),
    drmResolver: createMpdDrmResolver({ browser, swSessionId }),
    forcePlayback: createForcePlayback({ browser }),
    logger: (m) => process.stdout.write(`[capture] ${m}\n`),
  });

  const harvest = createHarvestRun({
    workItems,
    catalog,
    catalogPath: args.out,
    captureChildId: loop.captureChildId,
    concurrency,
    heartbeatIntervalMs,
    heartbeatSink: (s) => process.stdout.write(`${formatHeartbeat(s)}\n`),
    logger: (m) => process.stdout.write(`${m}\n`),
  });

  try {
    const report = await harvest.run();
    process.stdout.write(
      `[harvest] DONE attempted=${report.attempted} captured=${report.captured} ` +
        `failed=${report.failed} skipped=${report.skipped} accountingOk=${report.accountingOk}\n`,
    );
    if (report.errors.length) {
      process.stderr.write(`[harvest] ${report.errors.length} error(s):\n`);
      for (const e of report.errors) process.stderr.write(`  - ${e.childId}: ${e.error}\n`);
    }
    return report.failed > 0 ? 1 : 0;
  } finally {
    await harness.closeAllTabs().catch(() => {});
    browser.close();
  }
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(1);
    },
  );
}
