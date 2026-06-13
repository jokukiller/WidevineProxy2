# pi-harvester — local Key_Harvester (browser + CDM)

Feature: `pi-scrape-pipeline`. This is the **only** component that runs on the
operator's local machine (Req 14.1): it drives Opera GX + the WidevineProxy2
extension over CDP to capture each lecture's content key once into the permanent
`key-catalog.json`. The remote half (manifest/duration resolution, batch
controller, token refresh) lives under `codespaces/pi-pipeline/` and never runs
here.

## Files

- `cdp-harness.mjs` — fresh-tab-per-lecture, dialog auto-accept, MV3 SW wake,
  single-attach guard, per-lecture watchdog (Task 10.1).
- `capture-loop.mjs` — per-childId capture: force playback to the first EME
  license, poll the extension for `{kid,key}`, classify `drmType` from the
  manifest ContentProtection systemId (Task 10.2).
- `harvest-run.mjs` — dedup + subject-priority work set, resume, persist-before-
  advance, bounded concurrency with serialized atomic writes, progress
  heartbeat (Task 10.3).
- `key-harvester.mjs` — the CLI entry point that wires the above to the live
  browser and the `KeyCatalog` model.
- `bot-login.mjs` — one-time dedicated bot login (Task 8).

## Running a harvest

Launch Opera GX with remote debugging and the extension loaded, then:

```
node pi-harvester/key-harvester.mjs \
  --assets ../crawler-output/pi-assets.json \
  --placements ../crawler-output/pi-placements.json \
  --out ./key-catalog.json [--subject "<name>"] [--concurrency N] [--ext <extId>]
```

The run is resumable: an existing `--out` catalog is loaded and only
non-captured childIds are re-attempted; a captured childId is never re-captured.

## Tests

`npm test` (vitest) runs the offline suite with **no browser and no PW account**:

- `test/cdp-harness.test.mjs`, `test/capture-loop.test.mjs`,
  `test/harvest-run.test.mjs` — unit tests with injected fakes.
- `test/integration-resume.test.mjs` — **Task 10.4 part 2 (offline, CI):** drives
  a full harvest run that crashes mid-way, then resumes from the same on-disk
  `KeyCatalog` and asserts captured childIds are not re-captured, only the
  non-captured (incl. the in-flight/failed one) are re-attempted, and every
  captured `{kid,key}` is retained byte-for-byte (Properties 1 & 2; Req 3.3, 14.5).

### Gated live capture (Task 10.4 part 1 — MANUAL, skipped by default)

`test/integration-live-capture.test.mjs` captures one **known ClearKey** lecture
and one **known Widevine** lecture end-to-end through the real harness +
capture-loop and verifies the resulting `KeyCatalog` entry carries
`{kid,key,drmType}` with the expected `drmType` (Req 1.4, 1.5). It also confirms
a second capture of the same childId is skipped (Property 2 / Req 3.3).

It is **skipped unless** `PI_HARVEST_LIVE=1`, so the default `npm test` stays
green offline. To run it:

1. Launch Opera GX with remote debugging and log in to a PW account:

   ```
   "C:\Users\<you>\AppData\Local\Programs\Opera GX\opera.exe" --remote-debugging-port=9222
   ```

   Open the extension panel once so the MV3 service worker is awake.

2. Export the gate plus the known childIds (watch URLs default to
   `https://www.pw.live/watch/?childId=<childId>`, or set them explicitly):

   ```powershell
   $env:PI_HARVEST_LIVE              = "1"          # master gate
   $env:PI_HARVEST_CLEARKEY_CHILD    = "<childId>"  # a known ClearKey lecture
   $env:PI_HARVEST_WIDEVINE_CHILD    = "<childId>"  # a known Widevine lecture
   # optional explicit watch URLs:
   $env:PI_HARVEST_CLEARKEY_WATCHURL = "https://www.pw.live/watch/?...childId=..."
   $env:PI_HARVEST_WIDEVINE_WATCHURL = "https://www.pw.live/watch/?...childId=..."
   # optional dev-copy extension id (defaults to the known one):
   $env:PI_HARVEST_EXT_ID            = "pkoikjplcdkipeogmopelecfnfpaddcl"
   ```

   Use `probe-drm.mjs` / `probe-mpd.mjs` to find childIds of each DRM type. If a
   DRM-specific childId is unset, that DRM's test is individually skipped, so you
   can validate one type at a time.

3. Run just this file:

   ```
   npx vitest --run test/integration-live-capture.test.mjs
   ```

Without `PI_HARVEST_LIVE=1` the whole block is skipped and contributes zero
executed tests.
