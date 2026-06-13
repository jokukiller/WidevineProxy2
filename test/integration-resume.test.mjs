// test/integration-resume.test.mjs — Task 10.4 part 2 (OFFLINE, runs in CI).
//
// Feature: pi-scrape-pipeline — Task 10.4 "Integration check (gated/manual)".
//
// This is the NON-gated half of the integration check: it drives a FULL
// Key_Harvester run with a fake capture function that "crashes"/interrupts
// mid-way (the in-flight childId never persists and later childIds are never
// attempted), then starts a SECOND run that reuses the SAME on-disk Key_Catalog
// and asserts the resume contract end-to-end:
//
//   - already-`captured` childIds are NOT re-captured (skipped),
//   - only the non-captured childIds (including the in-flight one that was
//     interrupted, and any genuinely-failed one) are re-attempted, and
//   - every previously captured {kid,key} pair is retained BYTE-FOR-BYTE — the
//     resumed run never overwrites or mutates a captured entry.
//
// It uses a REAL KeyCatalog persisted to a temp file (atomic temp-file+rename
// writes) and the REAL createHarvestRun loop — no browser, no PW account, so it
// is safe to run on every `npm test` in CI. The browser-driven end-to-end check
// lives in the gated, skipped-by-default `integration-live-capture.test.mjs`.
//
// Validates: Properties 1, 2
// _Requirements: 3.3, 14.5_

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildWorkSet, createHarvestRun } from '../pi-harvester/harvest-run.mjs';
import { KeyCatalog } from '../../../codespaces/pi-pipeline/src/key-catalog.mjs';
import { CAPTURE_STATUS, FAILURE_REASON } from '../pi-harvester/capture-loop.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'resume-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function watchUrl(childId) {
  return `https://www.pw.live/watch/?categoryId=cat&childId=${childId}`;
}
function placement(childId, subject) {
  return { childId, subject, watchUrl: watchUrl(childId) };
}

/** Deterministic captured pair derived from the childId. */
function captured(childId, drmType = 'CLEARKEY') {
  return {
    childId,
    status: CAPTURE_STATUS.CAPTURED,
    kid: `kid-${childId}`,
    key: `key-${childId}`,
    kty: 'oct',
    drmType,
    attempts: 1,
  };
}

/** Sentinel thrown by the crash signal to model the process dying mid-run. */
class SimulatedProcessCrash extends Error {
  constructor() {
    super('simulated process crash mid-harvest');
    this.name = 'SimulatedProcessCrash';
  }
}

describe('resume after a mid-run interruption (Properties 1 & 2; Req 3.3, 14.5)', () => {
  it('re-attempts exactly the non-captured childIds and retains captured pairs byte-for-byte', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');

    // The full work set the operator intended to harvest, in subject-priority
    // order: a, b (succeed), fail1 (genuine capture failure), CRASH (in-flight
    // when the process dies), then d, e (never reached in run 1).
    const work = buildWorkSet({
      placements: [
        placement('a', 'Math'),
        placement('b', 'Math'),
        placement('fail1', 'Math'),
        placement('CRASH', 'Physics'),
        placement('d', 'Physics'),
        placement('e', 'Physics'),
      ],
    });
    expect(work.map((w) => w.childId)).toEqual(['a', 'b', 'fail1', 'CRASH', 'd', 'e']);

    // ---- RUN 1: crashes while 'CRASH' is in flight -----------------------
    const catalog1 = await KeyCatalog.load(catalogPath);
    const seen1 = [];

    let crashReject;
    const crashSignal = new Promise((_resolve, reject) => {
      crashReject = reject;
    });

    const run1 = createHarvestRun({
      workItems: work,
      catalog: catalog1,
      catalogPath,
      concurrency: 1, // strict sequential order so the crash point is deterministic
      captureChildId: async (item) => {
        seen1.push(item.childId);
        if (item.childId === 'fail1') {
          // A genuine capture failure: persisted into the `failed` map, never
          // a captured key. Stays eligible for a future attempt (Req 2.5).
          return {
            childId: item.childId,
            status: CAPTURE_STATUS.FAILED,
            reason: FAILURE_REASON.NO_USABLE_KEY,
            attempts: 3,
          };
        }
        if (item.childId === 'CRASH') {
          // Model the process being killed mid-capture: signal the crash and
          // never settle, so this childId is in-flight (never persisted) and
          // the remaining childIds (d, e) are never attempted.
          crashReject(new SimulatedProcessCrash());
          return new Promise(() => {}); // hang — this capture never completes
        }
        return captured(item.childId);
      },
    });

    // Abandon run 1 the moment the crash fires (the run() promise never settles,
    // exactly like a real interruption — the on-disk catalog is whatever landed).
    await expect(Promise.race([run1.run(), crashSignal])).rejects.toBeInstanceOf(
      SimulatedProcessCrash,
    );

    // What actually got attempted before the crash, in order.
    expect(seen1).toEqual(['a', 'b', 'fail1', 'CRASH']);

    // The on-disk catalog after the crash: a, b captured; fail1 recorded failed;
    // CRASH/d/e absent. Reads come from durable storage (atomic writes).
    const onDisk = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(Object.keys(onDisk.entries).sort()).toEqual(['a', 'b']);
    expect(onDisk.failed.fail1).toBeTruthy();
    expect(onDisk.entries.CRASH).toBeUndefined();
    expect(onDisk.entries.d).toBeUndefined();
    expect(onDisk.entries.e).toBeUndefined();

    // Snapshot the captured pairs so we can prove byte-for-byte retention later.
    const aBefore = JSON.stringify(onDisk.entries.a);
    const bBefore = JSON.stringify(onDisk.entries.b);

    // ---- RUN 2: resume from the same on-disk catalog ---------------------
    const catalog2 = await KeyCatalog.load(catalogPath);
    const seen2 = [];
    const run2 = createHarvestRun({
      workItems: work, // the SAME full work set
      catalog: catalog2,
      catalogPath,
      concurrency: 1,
      captureChildId: async (item) => {
        seen2.push(item.childId);
        // Return DELIBERATELY DIFFERENT key bytes. If the resume logic wrongly
        // re-captured an already-captured childId, the append-only catalog must
        // STILL retain the original pair — this makes any overwrite detectable.
        return {
          ...captured(item.childId),
          kid: `RESUMED-kid-${item.childId}`,
          key: `RESUMED-key-${item.childId}`,
        };
      },
    });
    const report = await run2.run();

    // Property 2 (resume safety): captured childIds are NEVER re-captured; only
    // the non-captured ones — the failed one and the in-flight one plus the
    // never-reached d, e — are re-attempted.
    expect(seen2).toEqual(['fail1', 'CRASH', 'd', 'e']);
    expect(seen2).not.toContain('a');
    expect(seen2).not.toContain('b');

    // Run accounting: 2 skipped (a, b already captured) + 4 captured this run.
    expect(report.attempted).toBe(6);
    expect(report.skipped).toBe(2);
    expect(report.captured).toBe(4);
    expect(report.failed).toBe(0);
    expect(report.accountingOk).toBe(true);

    // Property 1 (append-only / retention): a, b keep their EXACT original
    // {kid,key} byte-for-byte — the resumed run did not overwrite them despite
    // offering different bytes.
    const finalDisk = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(JSON.stringify(finalDisk.entries.a)).toBe(aBefore);
    expect(JSON.stringify(finalDisk.entries.b)).toBe(bBefore);
    expect(finalDisk.entries.a.key).toBe('key-a');
    expect(finalDisk.entries.b.key).toBe('key-b');

    // The previously-failed and in-flight childIds are now captured, and the
    // catalog holds every distinct childId exactly once (dedup invariant).
    expect(catalog2.has('fail1')).toBe(true);
    expect(catalog2.has('CRASH')).toBe(true);
    expect(catalog2.has('d')).toBe(true);
    expect(catalog2.has('e')).toBe(true);
    expect(Object.keys(finalDisk.entries).sort()).toEqual(['CRASH', 'a', 'b', 'd', 'e', 'fail1']);
    // fail1 moved out of the failed map once captured (mutually-exclusive state).
    expect(finalDisk.failed.fail1).toBeUndefined();
  });

  it('an interrupted write leaves the previous catalog intact and readable (Property 2)', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');

    // Seed and persist a healthy catalog with one captured pair.
    const seed = new KeyCatalog();
    seed.put('keep', { kid: 'kid-keep', key: 'key-keep', drmType: 'CLEARKEY' });
    await seed.save(catalogPath);
    const before = await readFile(catalogPath, 'utf8');

    // A run whose persistence step always fails (e.g. interrupted/half-written):
    // the harvester rolls back the in-memory put, marks the childId failed, and
    // leaves the PREVIOUS catalog on disk untouched (atomic temp-file+rename).
    const catalog = await KeyCatalog.load(catalogPath);
    const run = createHarvestRun({
      workItems: buildWorkSet({ placements: [placement('new1', 'S')] }),
      catalog,
      saveCatalog: async () => {
        throw new Error('simulated write interruption');
      },
      captureChildId: async (item) => captured(item.childId),
    });
    const report = await run.run();

    // The capture itself succeeded but persistence failed → recorded as failed,
    // surfaced with the affected childId; nothing partial reached disk.
    expect(report.captured).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.errors.some((e) => e.childId === 'new1')).toBe(true);

    // The on-disk catalog is byte-identical to before the interrupted run.
    const after = await readFile(catalogPath, 'utf8');
    expect(after).toBe(before);

    // And it still loads cleanly with the original captured pair intact.
    const reloaded = await KeyCatalog.load(catalogPath);
    expect(reloaded.has('keep')).toBe(true);
    expect(reloaded.get('keep').key).toBe('key-keep');
    expect(reloaded.has('new1')).toBe(false);
  });
});
