// probe-stream.mjs — navigate the live pw.live tab to a watch URL and capture
// the real stream-resolution + DRM network traffic (request params + response
// bodies) so we can see exactly how video-url-details / manifest / license work.
//
// Usage: node probe-stream.mjs "<watchUrl>" [secs]
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const watchUrl = process.argv[2];
const secs = Number(process.argv[3] || 25);
if (!watchUrl) { console.error('Usage: node probe-stream.mjs "<watchUrl>" [secs]'); process.exit(2); }

const MATCH = /penpencil\.co|license|getlicense|drm|clearkey|widevine|keyos|pallycon|ezdrm|\/ck\b|cwip|playready|fairplay|otp|\/key/i;
const NOISE = /googletagmanager|google-analytics|doubleclick|facebook|clarity|moengage|mixpanel|sentry|gtm|firebase|unleash|\.png|\.jpg|\.webp|\.svg|\.css|\.woff|\.mpd|\.m4s|video-stats|sync-stats|register-session|user-data|widget|category|playlist|notification|config/i;

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
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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

// Open a FRESH tab — reusing a watch tab triggers its beforeunload "Leave site?"
// modal, which pauses the renderer and deadlocks CDP domain-enables.
const { targetId } = await send(ws, pending, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send(ws, pending, 'Target.attachToTarget', { targetId, flatten: true });

await send(ws, pending, 'Network.enable', {}, sessionId);
await send(ws, pending, 'Page.enable', {}, sessionId).catch(() => {});
await send(ws, pending, 'Runtime.enable', {}, sessionId).catch(() => {});

// Auto-accept the page's beforeunload "Leave site?" dialog (it blocks Page.navigate otherwise).
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Page.javascriptDialogOpening') {
    send(ws, pending, 'Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  }
});
// Clear any dialog already open from a previous stuck run.
await send(ws, pending, 'Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});

const reqs = new Map(); // requestId -> {url, method, postData, status, mime}
const finished = [];
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  const p = msg.params || {};
  if (msg.method === 'Network.requestWillBeSent') {
    if (!p.request || NOISE.test(p.request.url) || !MATCH.test(p.request.url)) return;
    reqs.set(p.requestId, { url: p.request.url, method: p.request.method, postData: p.request.postData || null });
  } else if (msg.method === 'Network.responseReceived') {
    const r = reqs.get(p.requestId); if (!r) return;
    r.status = p.response.status; r.mime = p.response.mimeType;
  } else if (msg.method === 'Network.loadingFinished') {
    if (reqs.has(p.requestId)) finished.push(p.requestId);
  }
});

console.log(`Navigating tab -> ${watchUrl}`);
await send(ws, pending, 'Page.navigate', { url: watchUrl }, sessionId);

// Try to start playback (some calls only fire on play) with a user gesture eval.
for (let i = 0; i < Math.floor(secs / 2); i++) {
  await new Promise(r => setTimeout(r, 2000));
  await send(ws, pending, 'Runtime.evaluate', {
    expression: `(()=>{try{const v=document.querySelector('video'); if(v){v.muted=true; v.play&&v.play().catch(()=>{});} const b=[...document.querySelectorAll('button,[role="button"]')].find(x=>/play/i.test(x.getAttribute('aria-label')||'')); b&&b.click&&b.click(); return !!v;}catch(e){return 'err:'+e.message}})()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  }, sessionId).catch(() => {});
}

console.log(`\nCaptured ${reqs.size} matching request(s).\n`);
const watchdog = setTimeout(() => { console.log('\n[watchdog] forcing exit'); try { ws.close(); } catch {} process.exit(0); }, 12000);
for (const [requestId, r] of reqs) {
  console.log('----------------------------------------------------------------');
  console.log(`${r.method} ${r.url}`);
  console.log(`  status=${r.status || '?'} mime=${r.mime || '?'}`);
  if (r.postData) console.log(`  POST body: ${String(r.postData).slice(0, 800)}`);
}
const bodyWithTimeout = (requestId) => Promise.race([
  send(ws, pending, 'Network.getResponseBody', { requestId }, sessionId).catch(e => ({ body: '(err ' + e.message + ')', base64Encoded: false })),
  new Promise(res => setTimeout(() => res({ body: '(timeout)', base64Encoded: false }), 2500)),
]);
console.log('\n=== response bodies (finished requests) ===');
for (const requestId of finished) {
  const r = reqs.get(requestId);
  if (!r) continue;
  const { body, base64Encoded } = await bodyWithTimeout(requestId);
  console.log('----------------------------------------------------------------');
  console.log(`${r.method} ${r.url.slice(0, 140)}`);
  if (body && !base64Encoded) console.log('  body:', body.slice(0, 1200));
  else if (body) console.log('  body(b64 first120):', body.slice(0, 120));
}
clearTimeout(watchdog);
try { await send(ws, pending, 'Target.closeTarget', { targetId }); } catch {}
ws.close();
process.exit(0);
