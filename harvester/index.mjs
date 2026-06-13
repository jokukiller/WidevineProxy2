// harvester/index.mjs — local Key_Harvester entry point (Task 10 lands here).
//
// LOCAL-ONLY component (Req 14.1): the Key_Harvester is the *only* part of the
// pi-scrape-pipeline permitted to run on the local machine. It drives Opera GX
// over CDP through the existing WidevineProxy2 extension to capture {kid,key}
// pairs into a resumable Key_Catalog. Everything else (Manifest_Resolver,
// Batch_Controller, token refresh, on-demand PW_API) runs remotely.
//
// Reuse, don't rebuild (no new browser deps):
//   - ../cdp-debug.mjs        — the working CDP client (targets/navigate/eval/…)
//   - the `ws` dependency already vendored in this package's node_modules
//   - probe-stream.mjs / probe-mpd.mjs / probe-drm.mjs as references for
//     driving a watch page, resolving the .mpd, and classifying DRM.
//
// Browser facts (see ../PI_CRAWLER.md and the spec HANDOFF.md §1):
//   - Opera GX remote debug port: 9222 (CDP_PORT env overrides).
//   - Extension id (dev copy): pkoikjplcdkipeogmopelecfnfpaddcl
//   - MV3 service worker idles — wake it by opening
//     chrome-extension://<extId>/panel/panel.html
//   - Attach to each CDP target EXACTLY once (a second Target.attachToTarget
//     throws a sessionId protocol error).
//   - The PW watch page arms a beforeunload "Leave site?" dialog that blocks
//     Page.navigate and deadlocks CDP — always use a FRESH tab per lecture and
//     register Page.javascriptDialogOpening → handleJavaScriptDialog{accept}.
//
// This file is intentionally a scaffold: the capture loop, persistence/resume,
// concurrency, and heartbeat are implemented in Task 10.

export const HARVESTER_ROLE = 'local-only';

/** Opera GX remote debugging port (matches cdp-debug.mjs). */
export const CDP_PORT = process.env.CDP_PORT || 9222;

/** WidevineProxy2 dev extension id used to wake/poll the EME capture log. */
export const EXTENSION_ID = 'pkoikjplcdkipeogmopelecfnfpaddcl';

export async function main() {
  throw new Error(
    'Key_Harvester not yet implemented — see Task 10 in ' +
      '.kiro/specs/pi-scrape-pipeline/tasks.md',
  );
}

// Allow `node harvester/index.mjs` once implemented; no-op import side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
