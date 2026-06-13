// probe-sweep-orphans.mjs — close ORPHANED watch tabs left behind when a harvest
// process was hard-killed (stop bypasses the harness tab cleanup). A healthy
// active capture only needs the first license, so its tab is fresh (small ct,
// actively playing) and short-lived. Orphans are either playing well past any
// capture window OR paused/stalled. Close those; protect fresh active tabs.
//
// Heuristic per watch PAGE target:
//   CLOSE if  ct > CT_MAX (default 30s)   -> long-playing orphan
//        or   (paused === true && rs >= 1) -> loaded-but-stalled orphan
//   KEEP  otherwise                        -> fresh/loading active capture
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const CT_MAX = Number(process.argv[2] || 30);
async function hj(p) { return (await fetch(`http://${HOST}:${PORT}${p}`)).json(); }
function mk(ws, pend) { return (m, pa = {}, s) => { const id = mk._id = (mk._id || 0) + 1; const pl = { id, method: m, params: pa }; if (s) pl.sessionId = s; return new Promise((r, j) => { pend.set(id, { resolve: r, reject: j }); ws.send(JSON.stringify(pl)); }); }; }
const v = await hj('/json/version');
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const pend = new Map();
ws.on('message', b => { const m = JSON.parse(b); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } });
const S = mk(ws, pend);
const list = (await hj('/json/list')).filter(t => t.type === 'page' && (t.url || '').includes('watch'));
console.log(`watch PAGE tabs: ${list.length} (CT_MAX=${CT_MAX}s)`);
let closed = 0, kept = 0;
for (const t of list) {
  const cid = (t.url.match(/childId=([a-f0-9]+)/) || [])[1] || '?';
  let st = {};
  try {
    const sess = (await S('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId;
    await S('Runtime.enable', {}, sess).catch(() => {});
    const r = await S('Runtime.evaluate', { expression: `(()=>{const v=document.querySelector('video');return JSON.stringify({ct:v?+v.currentTime:null,rs:v?v.readyState:null,paused:v?v.paused:null});})()`, returnByValue: true }, sess).catch(() => ({ result: { value: '{}' } }));
    st = JSON.parse(r.result.value || '{}');
    await S('Target.detachFromTarget', { sessionId: sess }).catch(() => {});
  } catch {}
  const longPlay = st.ct != null && st.ct > CT_MAX;
  const stalled = st.paused === true && (st.rs ?? 0) >= 1;
  if (longPlay || stalled) {
    await S('Target.closeTarget', { targetId: t.id }).catch(() => {});
    console.log(`  CLOSE child=${cid} ct=${st.ct} rs=${st.rs} paused=${st.paused}`);
    closed++;
  } else {
    console.log(`  keep  child=${cid} ct=${st.ct} rs=${st.rs} paused=${st.paused}`);
    kept++;
  }
}
console.log(`\nsweep: closed=${closed} kept=${kept}`);
ws.close(); process.exit(0);
