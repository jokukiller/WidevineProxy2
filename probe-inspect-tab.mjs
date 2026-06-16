// probe-inspect-tab.mjs <childIdSubstr> — inspect a specific watch tab: URL,
// readyState, title, whether a <video> exists + its state, visible body text,
// and recent console errors, to diagnose why it's stuck/open.
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const needle = process.argv[2] || '6a0ece96';
async function hj(p) { return (await fetch(`http://${HOST}:${PORT}${p}`)).json(); }
function mk(ws, pend, ls) { return (m, pa = {}, s) => { const id = mk._id = (mk._id || 0) + 1; const pl = { id, method: m, params: pa }; if (s) pl.sessionId = s; return new Promise((r, j) => { pend.set(id, { resolve: r, reject: j }); ws.send(JSON.stringify(pl)); }); }; }
const v = await hj('/json/version');
const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const pend = new Map(); const ls = [];
ws.on('message', b => { const m = JSON.parse(b); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } else if (m.method) { for (const l of ls) l(m); } });
const S = mk(ws, pend, ls);
const tab = (await hj('/json/list')).find(t => t.type === 'page' && (t.url || '').includes(needle));
if (!tab) { console.log('no tab matching', needle); ws.close(); process.exit(0); }
console.log('targetId:', tab.id);
console.log('url:', tab.url);
console.log('title:', JSON.stringify(tab.title));
const sess = (await S('Target.attachToTarget', { targetId: tab.id, flatten: true })).sessionId;
await S('Runtime.enable', {}, sess).catch(() => {});
const errors = [];
ls.push(m => { if (m.sessionId === sess && m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160)); });
const expr = `(()=>{const v=document.querySelector('video');return JSON.stringify({
  readyState: document.readyState,
  href: location.href,
  visText: (document.body?.innerText||'').replace(/\\s+/g,' ').trim().slice(0,300),
  hasVideo: !!v,
  videoState: v?{ct:+v.currentTime.toFixed(1),rs:v.readyState,paused:v.paused,err:v.error?v.error.code:null,netState:v.networkState}:null,
  vis: document.visibilityState
});})()`;
const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true }, sess).catch(e => ({ result: { value: 'ERR ' + e.message } }));
console.log('state:', r.result.value);
await new Promise(r => setTimeout(r, 800));
if (errors.length) console.log('recent console errors:', errors.slice(0, 5));
await S('Target.detachFromTarget', { sessionId: sess }).catch(() => {});
ws.close(); process.exit(0);
