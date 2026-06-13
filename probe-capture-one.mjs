// probe-capture-one.mjs — END-TO-END live validation of the capture path for ONE
// lecture, using the REAL production wiring (cdp-harness + capture-loop + the
// extension capture reader + mpd drm resolver + force-playback), navigating to
// the watchUrl with the bugfix applied (ensurePlayableWatchUrl). Confirms a
// real {kid,key,drmType} is captured. Does NOT persist a catalog.
//
// Usage: node probe-capture-one.mjs [childId]
import { Browser } from './cdp-debug.mjs';
import { createCdpHarness } from './pi-harvester/cdp-harness.mjs';
import {
  createCaptureLoop,
  createExtensionCaptureReader,
  createMpdDrmResolver,
  createForcePlayback,
} from './pi-harvester/capture-loop.mjs';
import { ensurePlayableWatchUrl } from '../../codespaces/pi-pipeline/src/watch-url.mjs';
import { readFileSync } from 'node:fs';

const childId = process.argv[2] || '69a00bd50e6503b008fec1ad';
const placements = JSON.parse(readFileSync('../crawler-output/pi-placements.json', 'utf8'));
const p = placements.find((x) => x.childId === childId);
if (!p) { console.error('childId not found in placements:', childId); process.exit(2); }

const storedUrl = p.watchUrl;
const playableUrl = ensurePlayableWatchUrl(storedUrl);
console.log('childId   :', childId, '| subject:', p.subject);
console.log('stored URL:', storedUrl);
console.log('playable  :', playableUrl);
console.log('(fix added:', playableUrl !== storedUrl ? 'vType/type' : 'nothing — already complete', ')\n');

const browser = await Browser.connect();
const harness = createCdpHarness({ browser });
const { sessionId: swSessionId } = await harness.wakeServiceWorker();
if (!swSessionId) { console.error('could not wake WidevineProxy2 SW'); browser.close(); process.exit(1); }

const loop = createCaptureLoop({
  harness,
  captureReader: createExtensionCaptureReader({ browser, swSessionId }),
  drmResolver: createMpdDrmResolver({ browser, swSessionId }),
  forcePlayback: createForcePlayback({ browser }),
  logger: (m) => console.log('[capture]', m),
});

console.log('Capturing (60s nav budget, up to 3 attempts)...');
const t0 = Date.now();
const result = await loop.captureChildId({ childId, watchUrl: playableUrl });
console.log(`\n=== RESULT (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
console.log(JSON.stringify(result, null, 2));

await harness.closeAllTabs().catch(() => {});
browser.close();
process.exit(result && result.status === 'captured' ? 0 : 1);
