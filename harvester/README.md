# Key_Harvester (local)

The local, browser+CDP half of the **pi-scrape-pipeline**. This is the only
pipeline component permitted to run on the local machine (Req 14.1). It drives
Opera GX over the Chrome DevTools Protocol through the existing **WidevineProxy2**
extension to capture `{kid, key}` pairs into a resumable `Key_Catalog`, then
publishes that catalog to the remote half (Task 11).

## Why it lives here

It reuses this package's existing CDP tooling and `ws` dependency — **no new
browser dependencies are introduced**:

- `../cdp-debug.mjs` — the working CDP client (targets, navigate, eval, watch…).
- `../probe-stream.mjs` — reference for driving a watch page without deadlocking.
- `../probe-mpd.mjs` / `../probe-drm.mjs` — reference for resolving the `.mpd`
  and classifying DRM from the ContentProtection systemId.

## Prerequisites

Launch Opera GX with the remote debugging port on your normal profile (so the
extension + PW login persist), then run the harvester:

```
& "C:\Users\anas\AppData\Local\Programs\Opera GX\opera.exe" --remote-debugging-port=9222
node harvester/index.mjs
```

- Opera GX remote debug port: **9222** (`CDP_PORT` env overrides).
- WidevineProxy2 dev extension id: `pkoikjplcdkipeogmopelecfnfpaddcl`.
- The MV3 service worker idles — wake it by opening
  `chrome-extension://<extId>/panel/panel.html`.

## Status

Scaffold only. The capture loop, atomic/resumable persistence, `--concurrency`
parallel tabs, and the progress heartbeat are implemented in **Task 10** of
`.kiro/specs/pi-scrape-pipeline/tasks.md`.
