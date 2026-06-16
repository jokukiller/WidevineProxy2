// test/harvest-run.test.mjs — unit tests for the Key_Harvester run loop.
//
// Feature: pi-scrape-pipeline — Task 10.3. Drives a full harvest run with FAKE
// captures over a REAL KeyCatalog persisted to a temp file — no browser. Covers:
//   - resume skips captured childIds and re-attempts only non-captured ones
//   - a successful capture is persisted (atomic save) BEFORE advancing
//   - concurrency (N>1) with serialized writes keeps the catalog consistent
//   - subject-priority ordering and the --subject filter
//   - a failed capture leaves the captured set intact
//   - the heartbeat emits captured/pending/failed counts + ETA
//   - the final report's captured + failed + skipped == attempted (Req 16.4)
//
// _Requirements: 3.1, 3.6, 4.3, 14.4, 14.5, 14.6, 16.4_

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildWorkSet, createHarvestRun } from '../pi-harvester/harvest-run.mjs';
import { KeyCatalog } from '../../../codespaces/pi-pipeline/src/key-catalog.mjs';
import { CAPTURE_STATUS, FAILURE_REASON } from '../pi-harvester/capture-loop.mjs';

// --- helpers ---------------------------------------------------------------

let dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harvest-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function watchUrl(childId, categoryId = 'cat') {
  return `https://www.pw.live/watch/?categoryId=${categoryId}&childId=${childId}`;
}

/** A placement record (subset of the real shape) for buildWorkSet. */
function placement(childId, subject, extra = {}) {
  return { childId, subject, watchUrl: watchUrl(childId), ...extra };
}

/** Fake capture: returns a captured pair derived from the childId. */
function fakeCapture({ childId }) {
  return {
    childId,
    status: CAPTURE_STATUS.CAPTURED,
    kid: `kid-${childId}`,
    key: `key-${childId}`,
    kty: 'oct',
    drmType: 'CLEARKEY',
    attempts: 1,
  };
}

/** Fake capture that fails for childIds in `failSet`. */
function makeSelectiveCapture(failSet) {
  return async ({ childId }) => {
    if (failSet.has(childId)) {
      return { childId, status: CAPTURE_STATUS.FAILED, reason: FAILURE_REASON.NO_USABLE_KEY, attempts: 3 };
    }
    return fakeCapture({ childId });
  };
}

// --- work set construction -------------------------------------------------

describe('buildWorkSet (dedup + subject-priority ordering, Req 1.1, 2.1, 4.3)', () => {
  it('dedups by childId and assigns each to its first-seen subject', () => {
    const placements = [
      placement('a', 'Math'),
      placement('b', 'Math'),
      placement('a', 'Physics'), // cross-branch duplicate of a
      placement('c', 'Physics'),
    ];
    const work = buildWorkSet({ placements });
    expect(work.map((w) => w.childId)).toEqual(['a', 'b', 'c']);
    // 'a' stays under Math (first seen), 'c' under Physics.
    expect(work.find((w) => w.childId === 'a').subject).toBe('Math');
    expect(work.find((w) => w.childId === 'c').subject).toBe('Physics');
  });

  it('emits work items grouped by subject in first-seen subject order', () => {
    const placements = [
      placement('a', 'Math'),
      placement('c', 'Physics'),
      placement('b', 'Math'),
    ];
    const work = buildWorkSet({ placements });
    // Math group (a,b) before Physics group (c) — subject-priority ordering.
    expect(work.map((w) => w.childId)).toEqual(['a', 'b', 'c']);
  });

  it('restricts to one subject with the --subject filter', () => {
    const placements = [
      placement('a', 'Math'),
      placement('b', 'Physics'),
      placement('c', 'Math'),
    ];
    const work = buildWorkSet({ placements, subject: 'Math' });
    expect(work.map((w) => w.childId)).toEqual(['a', 'c']);
    expect(work.every((w) => w.subject === 'Math')).toBe(true);
  });

  it('drops placements whose childId is absent from the asset universe', () => {
    const assets = [{ childId: 'a' }, { childId: 'b' }];
    const placements = [placement('a', 'Math'), placement('zzz', 'Math'), placement('b', 'Math')];
    const work = buildWorkSet({ assets, placements });
    expect(work.map((w) => w.childId)).toEqual(['a', 'b']);
  });

  it('emits work items whose watchUrl carries vType=OTT and type=penpencilvdo (bugfix)', () => {
    // The stored watchUrls are MISSING vType/type, which makes the PW player
    // hang on capture. buildWorkSet must ensure the harvester navigates to the
    // playable URL.
    const placements = [placement('a', 'Math'), placement('b', 'Physics')];
    const work = buildWorkSet({ placements });
    expect(work.length).toBe(2);
    for (const w of work) {
      const q = new URL(w.watchUrl).searchParams;
      expect(q.get('vType')).toBe('OTT');
      expect(q.get('type')).toBe('penpencilvdo');
      // childId is still present after the rewrite.
      expect(q.get('childId')).toBe(w.childId);
    }
  });
});

// --- resume ----------------------------------------------------------------

describe('resume (Req 3.2, 3.3, 14.5, 14.6)', () => {
  it('skips already-captured childIds and re-attempts only non-captured ones', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    // Seed a catalog with 'a' already captured.
    const seed = new KeyCatalog();
    seed.put('a', { kid: 'kid-a', key: 'key-a', drmType: 'CLEARKEY' });
    await seed.save(catalogPath);

    const catalog = await KeyCatalog.load(catalogPath);
    const seen = [];
    const work = buildWorkSet({
      placements: [placement('a', 'S'), placement('b', 'S'), placement('c', 'S')],
    });
    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      catalogPath,
      captureChildId: async (item) => {
        seen.push(item.childId);
        return fakeCapture(item);
      },
    });

    const report = await harvest.run();

    // 'a' is never re-captured; only 'b' and 'c' are attempted.
    expect(seen).toEqual(['b', 'c']);
    expect(report.skipped).toBe(1);
    expect(report.captured).toBe(2);
    expect(report.attempted).toBe(3);
    // The original captured pair for 'a' is retained unchanged.
    expect(catalog.get('a').key).toBe('key-a');
  });

  it('re-attempts a previously failed (non-captured) childId on resume', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    const seed = new KeyCatalog();
    seed.markFailed('b', 'navigation-timeout');
    await seed.save(catalogPath);

    const catalog = await KeyCatalog.load(catalogPath);
    const seen = [];
    const harvest = createHarvestRun({
      workItems: buildWorkSet({ placements: [placement('b', 'S')] }),
      catalog,
      catalogPath,
      captureChildId: async (item) => {
        seen.push(item.childId);
        return fakeCapture(item);
      },
    });
    const report = await harvest.run();
    expect(seen).toEqual(['b']); // failed → still pending → re-attempted
    expect(report.captured).toBe(1);
    expect(catalog.has('b')).toBe(true);
  });

  it('skips previously-failed childIds when skipFailed is set (no re-grind)', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    const seed = new KeyCatalog();
    seed.markFailed('b', 'navigation-timeout'); // a known perpetual failure
    await seed.save(catalogPath);

    const catalog = await KeyCatalog.load(catalogPath);
    const seen = [];
    const harvest = createHarvestRun({
      workItems: buildWorkSet({
        placements: [placement('a', 'S'), placement('b', 'S'), placement('c', 'S')],
      }),
      catalog,
      catalogPath,
      skipFailed: true,
      captureChildId: async (item) => {
        seen.push(item.childId);
        return fakeCapture(item);
      },
    });

    const report = await harvest.run();

    // 'b' was already failed and is NOT re-attempted; only fresh ids run.
    expect(seen).toEqual(['a', 'c']);
    expect(report.captured).toBe(2);
    // The skipped failure is counted as skipped, preserving the accounting
    // invariant captured + failed + skipped == attempted (Req 16.4).
    expect(report.skipped).toBe(1);
    expect(report.captured + report.failed + report.skipped).toBe(report.attempted);
  });
});

// --- persist before advancing ----------------------------------------------

describe('persist-before-advance (Req 3.1)', () => {
  it('writes the captured entry to durable storage before the next capture starts', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    const catalog = new KeyCatalog();
    const work = buildWorkSet({
      placements: [placement('a', 'S'), placement('b', 'S'), placement('c', 'S')],
    });

    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      catalogPath,
      concurrency: 1,
      captureChildId: async ({ childId }) => {
        // Before capturing this id, every previously sequenced id must already
        // be on disk (persist-before-advance with concurrency 1).
        const onDisk = JSON.parse(await readFile(catalogPath, 'utf8').catch(() => '{"entries":{}}'));
        if (childId === 'b') expect(onDisk.entries.a).toBeTruthy();
        if (childId === 'c') expect(onDisk.entries.b).toBeTruthy();
        return fakeCapture({ childId });
      },
    });

    const report = await harvest.run();
    expect(report.captured).toBe(3);
    const final = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(Object.keys(final.entries).sort()).toEqual(['a', 'b', 'c']);
  });
});

// --- concurrency with serialized writes ------------------------------------

describe('bounded concurrency with serialized writes (Req 14.4)', () => {
  it('keeps the catalog consistent under N>1 with no lost writes', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    const catalog = new KeyCatalog();
    const ids = Array.from({ length: 25 }, (_, i) => `id${i}`);
    const work = buildWorkSet({ placements: ids.map((id) => placement(id, 'S')) });

    // Guard: detect any overlapping (non-serialized) write.
    let writing = false;
    let overlapDetected = false;
    const saveCatalog = async () => {
      if (writing) overlapDetected = true;
      writing = true;
      // Yield to the event loop so an unserialized writer would interleave here.
      await new Promise((r) => setTimeout(r, 1));
      await catalog.save(catalogPath);
      writing = false;
    };

    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      saveCatalog,
      concurrency: 5,
      captureChildId: async (item) => {
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
        return fakeCapture(item);
      },
    });

    const report = await harvest.run();

    expect(overlapDetected).toBe(false); // writes were serialized (Req 14.4)
    expect(report.captured).toBe(25);
    // Every write survived on disk — no lost writes.
    const final = JSON.parse(await readFile(catalogPath, 'utf8'));
    expect(Object.keys(final.entries).sort()).toEqual([...ids].sort());
    expect(Object.keys(catalog.entries).sort()).toEqual([...ids].sort());
  });
});

// --- failure handling ------------------------------------------------------

describe('failed capture leaves the captured set intact (Req 2.5, 3.6)', () => {
  it('records the failure without mutating any captured entry', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    const catalog = new KeyCatalog();
    const work = buildWorkSet({
      placements: [placement('ok1', 'S'), placement('bad', 'S'), placement('ok2', 'S')],
    });

    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      catalogPath,
      captureChildId: makeSelectiveCapture(new Set(['bad'])),
    });
    const report = await harvest.run();

    expect(report.captured).toBe(2);
    expect(report.failed).toBe(1);
    expect(catalog.has('ok1')).toBe(true);
    expect(catalog.has('ok2')).toBe(true);
    expect(catalog.has('bad')).toBe(false);
    expect(catalog.failed.bad).toBeTruthy();
    expect(report.failures[0].childId).toBe('bad');
  });

  it('on a save failure, reverts the entry, marks failed, and surfaces the childId (Req 3.6)', async () => {
    const catalog = new KeyCatalog();
    const work = buildWorkSet({ placements: [placement('x', 'S')] });

    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      saveCatalog: async () => {
        throw new Error('disk full');
      },
      captureChildId: async (item) => fakeCapture(item),
    });
    const report = await harvest.run();

    expect(report.captured).toBe(0);
    expect(report.failed).toBe(1);
    // The captured entry was rolled back; the previous (empty) catalog is intact.
    expect(catalog.has('x')).toBe(false);
    expect(catalog.failed.x).toBeTruthy();
    // The surfaced error identifies the affected childId.
    expect(report.errors.some((e) => e.childId === 'x' && /persist-failed/.test(e.error))).toBe(true);
  });
});

// --- heartbeat -------------------------------------------------------------

describe('progress heartbeat', () => {
  it('emits captured/pending/failed counts, current ids, and an ETA', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    const catalog = new KeyCatalog();
    const work = buildWorkSet({
      placements: [placement('a', 'S'), placement('bad', 'S'), placement('c', 'S')],
    });

    const snapshots = [];
    // Fake scheduler: capture the interval callback so the test controls ticks.
    let intervalFn = null;
    let cleared = false;
    const scheduler = {
      setInterval: (fn) => {
        intervalFn = fn;
        return 'H';
      },
      clearInterval: (h) => {
        if (h === 'H') cleared = true;
      },
    };

    let now = 1_000;
    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      catalogPath,
      clock: () => now,
      heartbeatSink: (s) => snapshots.push(s),
      heartbeatIntervalMs: 1000,
      scheduler,
      captureChildId: async (item) => {
        now += 1000; // advance the clock so ETA is computable
        if (intervalFn) intervalFn(); // emit a heartbeat mid-run
        return makeSelectiveCapture(new Set(['bad']))(item);
      },
    });

    const report = await harvest.run();

    expect(cleared).toBe(true); // the interval was cleaned up
    expect(snapshots.length).toBeGreaterThan(0);
    const last = snapshots[snapshots.length - 1];
    expect(last.attempted).toBe(3);
    expect(last.captured).toBe(2);
    expect(last.failed).toBe(1);
    expect(last.pending).toBe(0);
    expect(Array.isArray(last.current)).toBe(true);
    // An ETA was computed once progress was made.
    expect(snapshots.some((s) => typeof s.etaMs === 'number')).toBe(true);
    expect(report.captured).toBe(2);
  });
});

// --- final accounting ------------------------------------------------------

describe('final accounting (Req 16.4)', () => {
  it('captured + failed + skipped == attempted across a mixed run', async () => {
    const catalogPath = path.join(dir, 'key-catalog.json');
    // Pre-capture 'p' so it is skipped on this run.
    const seed = new KeyCatalog();
    seed.put('p', { kid: 'kid-p', key: 'key-p', drmType: 'CLEARKEY' });
    await seed.save(catalogPath);
    const catalog = await KeyCatalog.load(catalogPath);

    const work = buildWorkSet({
      placements: [
        placement('p', 'S'), // skipped (already captured)
        placement('ok1', 'S'),
        placement('bad1', 'S'),
        placement('ok2', 'T'),
        placement('bad2', 'T'),
      ],
    });
    const harvest = createHarvestRun({
      workItems: work,
      catalog,
      catalogPath,
      concurrency: 2,
      captureChildId: makeSelectiveCapture(new Set(['bad1', 'bad2'])),
    });
    const report = await harvest.run();

    expect(report.attempted).toBe(5);
    expect(report.skipped).toBe(1);
    expect(report.captured).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.captured + report.failed + report.skipped).toBe(report.attempted);
    expect(report.accountingOk).toBe(true);
  });
});
