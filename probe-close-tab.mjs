// probe-close-tab.mjs <childIdSubstr> — close a specific watch tab by childId,
// but ONLY if it is NOT a focus-emulated (active-harvest) tab. A harness-owned
// active tab reports visibilityState 'visible'; an orphan reports 'hidden'.
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const needle = process.argv[2];
if (!needle) { console.log('usage: node probe-close-tab.mjs <childIdSubstr>'); process.exit(1); }
async function hj(p) { return (await fetch(`http://${HOST}:${PORT}${p}`)).json(); }
function mk(ws, pend) { return (m, pa = {}, s) => { const id = mk._id = (mk._id || 0) + 1; const pl = { id, method: m, params: pa }; if (s) pl.sessionId = s; return new Promise((r, j) => { pend.set(id, { resolve: r, reject: j }); ws.send(JSON.stringify(pl)); }); }; }
const v = await hj('/json/version');
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const pend = new Map();
ws.on('message', b => { const m = JSON.parse(b); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
const S = mk(ws, pend);
const tab = (await hj('/json/list')).find(t => t.type === 'page' && (t.url || '').includes(needle));
if (!tab) { console.log('no tab matching', needle, '(already gone?)'); ws.close(); process.exit(0); }
const sess = (await S('Target.attachToTarget', { targetId: tab.id, flatten: true })).sessionId;
await S('Runtime.enable', {}, sess).catch(() => {});
const vis = (await S('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sess).catch(() => ({ result: { value: '?' } }))).result.value;
await S('Target.detachFromTarget', { sessionId: sess }).catch(() => {});
if (vis === 'visible') {
  console.log(`SKIP ${needle}: visibilityState='visible' (looks like an active harvest tab) — not closing.`);
} else {
  await S('Target.closeTarget', { targetId: tab.id }).catch(() => {});
  console.log(`closed ${needle} (visibilityState='${vis}', orphan).`);
}
ws.close(); process.exit(0);
