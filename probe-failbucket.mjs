// probe-failbucket.mjs — classify every childId currently in key-catalog.failed
// into UNENCRYPTED (playable, no key) / DEAD (Video not found) / protected-other
// so the build-time Failure_Triage (native-order-catalog-rebuild Req 14) can keep
// unencrypted lectures instead of dropping them. Reference tool for that triage.
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1', EXT = 'pkoikjplcdkipeogmopelecfnfpaddcl';
const placements = JSON.parse(readFileSync('../crawler-output/pi-placements.json', 'utf8'));
const byId = new Map(placements.map(p => [p.childId, p]));
let cat = { entries: {}, failed: {} };
try { cat = JSON.parse(readFileSync('./key-catalog.json', 'utf8')); } catch {}
const failedIds = Object.keys(cat.failed || {});
console.log(`failed in catalog: ${failedIds.length}`);
if (!failedIds.length) process.exit(0);
async function hj(p) { return (await fetch(`http://${HOST}:${PORT}${p}`)).json(); }
function mk(ws, pend) { return (m, pa = {}, s) => { const id = mk._id = (mk._id || 0) + 1; const pl = { id, method: m, params: pa }; if (s) pl.sessionId = s; return new Promise((r, j) => { pend.set(id, { resolve: r, reject: j }); ws.send(JSON.stringify(pl)); }); }; }
const v = await hj('/json/version');
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const pend = new Map();
ws.on('message', b => { const m = JSON.parse(b); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
const S = mk(ws, pend);
const { targetInfos } = await S('Target.getTargets');
const sw = targetInfos.find(t => t.type === 'service_worker' && (t.url || '').includes(EXT));
const swSession = (await S('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
await S('Runtime.enable', {}, swSession);
async function classify(childId) {
  const expr = `(async () => {
    const a = (await chrome.storage.local.get('pwAuthToken')).pwAuthToken;
    const headers = { ...(a.capturedHeaders || {}), Authorization: 'Bearer ' + a.token };
    const u = 'https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId=' + ${JSON.stringify(childId)} + '&clientVersion=201';
    let r,j; try { r = await fetch(u,{headers}); j = await r.json(); } catch(e){ return 'NETERR'; }
    if (r.status !== 200 || !(j&&j.data&&j.data.url)) return 'DEAD:' + r.status + ':' + ((j&&(j.message||(j.error&&j.error.message)))||'no-url');
    try {
      const mpd = await (await fetch(j.data.url + (j.data.signedUrl||''))).text();
      const lo = mpd.toLowerCase();
      if (lo.includes('edef8ba9')) return 'WIDEVINE'; if (lo.includes('1077efec')) return 'CLEARKEY';
      if (lo.includes('contentprotection')) return 'OTHER-PROTECTED';
      return 'UNENCRYPTED';
    } catch(e){ return 'MPD-ERR'; }
  })()`;
  return S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSession).then(r => r.result.value).catch(() => 'EVALERR');
}
const buckets = {};
for (const id of failedIds) {
  const c = await classify(id);
  const key = c.startsWith('DEAD') ? 'DEAD' : c;
  buckets[key] = (buckets[key] || 0) + 1;
  const p = byId.get(id) || {};
  console.log(`  ${id} -> ${c}  | ${(p.subject||'?').slice(0,28)} / ${(p.lecture||'?').slice(0,34)}`);
}
console.log('\nBUCKETS:', JSON.stringify(buckets));
console.log('UNENCRYPTED here = playable content that currently lands in "failed" and would be dropped without triage.');
ws.close(); process.exit(0);
