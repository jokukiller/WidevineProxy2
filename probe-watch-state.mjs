// probe-watch-state.mjs — diagnose why playback won't start on a PW watch page.
// Fresh tab -> watchUrl, auto-accept dialogs, nudge play, and every few seconds
// report the real page/video state so we can see what's blocking the stream.
//
// Usage: node probe-watch-state.mjs "<watchUrl>" [secs]
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const watchUrl = process.argv[2];
const secs = Number(process.argv[3] || 40);
if (!watchUrl) { console.error('Usage: node probe-watch-state.mjs "<watchUrl>" [secs]'); process.exit(2); }

async function httpJson(path) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}
function send(ws, pending, method, params = {}, sessionId) {
  const id = send._id = (send._id || 0) + 1;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(payload));
  });
}

const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const pending = new Map();
const listeners = [];
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
  } else if (msg.method) { for (const l of listeners) l(msg); }
});

const { targetId } = await send(ws, pending, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send(ws, pending, 'Target.attachToTarget', { targetId, flatten: true });
await send(ws, pending, 'Page.enable', {}, sessionId).catch(() => {});
await send(ws, pending, 'Runtime.enable', {}, sessionId).catch(() => {});
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Page.javascriptDialogOpening') {
    send(ws, pending, 'Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  }
});

const evalIn = async (expr) => {
  const { result, exceptionDetails } = await send(ws, pending, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true,
  }, sessionId).catch((e) => ({ result: { value: 'EVALERR:' + e.message } }));
  if (exceptionDetails) return 'EXC:' + (exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
  return result?.value;
};

console.log(`Navigating -> ${watchUrl}`);
await send(ws, pending, 'Page.navigate', { url: watchUrl }, sessionId);

const STATE_EXPR = `(()=>{
  try {
    const vids=[...document.querySelectorAll('video')];
    const ifr=[...document.querySelectorAll('iframe')].map(f=>f.src).filter(Boolean);
    const v=vids[0];
    const txt=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').toLowerCase();
    const hint=['subscribe','unlock','buy','locked','upgrade','plan','login','sign in','purchase','not available','error'].filter(w=>txt.includes(w));
    const btns=[...document.querySelectorAll('button,[role="button"],[class*="play"],[class*="Play"]')].length;
    return {
      href: location.href,
      title: document.title,
      videos: vids.length,
      iframes: ifr.slice(0,5),
      v: v ? { rs: v.readyState, paused: v.paused, ct: +v.currentTime.toFixed(1), dur: (v.duration||0)|0, src: (v.currentSrc||'').slice(0,80), err: v.error && v.error.code } : null,
      buttons: btns,
      hints: hint,
      bodyLen: txt.length,
    };
  } catch(e){ return 'ERR:'+e.message; }
})()`;

const NUDGE = `(()=>{try{
  const v=document.querySelector('video');
  if(v){v.muted=true; const p=v.play&&v.play(); if(p&&p.catch)p.catch(()=>{});}
  const sels=['button[aria-label*="lay" i]','[class*="play" i]','[class*="Play"]','.vjs-big-play-button','button'];
  for(const s of sels){const el=document.querySelector(s); if(el){el.click&&el.click(); break;}}
  return !!v;
}catch(e){return 'err:'+e.message}})()`;

for (let i = 0; i < Math.floor(secs / 3); i++) {
  await new Promise(r => setTimeout(r, 3000));
  const nudged = await evalIn(NUDGE);
  const st = await evalIn(STATE_EXPR);
  console.log(`t+${(i + 1) * 3}s nudged=${nudged} ${JSON.stringify(st)}`);
}

try { await send(ws, pending, 'Target.closeTarget', { targetId }); } catch {}
ws.close();
process.exit(0);
