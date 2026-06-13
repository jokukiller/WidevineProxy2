// probe-enable.mjs — turn the extension's master capture toggle ON
// (chrome.storage.sync.enabled = true) so the RESPONSE handler reaches
// parseClearKey instead of short-circuiting. Verifies the written value.
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const EXT = 'pkoikjplcdkipeogmopelecfnfpaddcl';
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
if (!sw) { console.log('NO SW TARGET'); ws.close(); process.exit(1); }
const swSession = (await S('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
await S('Runtime.enable', {}, swSession);
const swEval = async e => { const r = await S('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, swSession).catch(err => ({ result: { value: 'EVAL_ERR:' + err.message } })); return r?.result?.value; };
const out = await swEval(`(async()=>{ await chrome.storage.sync.set({enabled:true}); const s = await chrome.storage.sync.get(['enabled']); return JSON.stringify(s); })()`);
console.log('after set:', out);
ws.close(); process.exit(0);
