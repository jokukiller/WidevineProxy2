// probe-console.mjs — navigate a fresh tab to a URL and stream its console
// output, thrown exceptions, and log entries, so we can see WHY a page (the PW
// watch page, or the extension panel) fails to render.
//
// Usage: node probe-console.mjs "<url>" [secs]
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const url = process.argv[2];
const secs = Number(process.argv[3] || 25);
if (!url) { console.error('Usage: node probe-console.mjs "<url>" [secs]'); process.exit(2); }

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
await send(ws, pending, 'Runtime.enable', {}, sessionId).catch(() => {});
await send(ws, pending, 'Log.enable', {}, sessionId).catch(() => {});
await send(ws, pending, 'Page.enable', {}, sessionId).catch(() => {});
await send(ws, pending, 'Network.enable', {}, sessionId).catch(() => {});

let failCount = 0;
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  const p = msg.params || {};
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (p.args || []).map(a => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
    console.log(`[console.${p.type}] ${String(args).slice(0, 400)}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails;
    console.log(`[EXCEPTION] ${(d?.exception?.description || d?.text || '').slice(0, 500)}`);
  } else if (msg.method === 'Log.entryAdded') {
    const e = p.entry;
    if (e.level === 'error' || e.level === 'warning') console.log(`[log.${e.level}] ${(e.text || '').slice(0, 300)}${e.url ? '  <' + e.url.slice(0, 90) + '>' : ''}`);
  } else if (msg.method === 'Network.loadingFailed') {
    failCount++;
    if (failCount <= 25) console.log(`[net-fail] ${p.errorText} ${p.type || ''} req=${p.requestId}`);
  }
});

console.log(`Navigating -> ${url}\n--- console / exceptions / log (errors+warnings) for ${secs}s ---`);
await send(ws, pending, 'Page.navigate', { url }, sessionId);
await new Promise(r => setTimeout(r, secs * 1000));

// Final DOM snapshot.
const { result } = await send(ws, pending, 'Runtime.evaluate', {
  expression: `({href:location.href,title:document.title,bodyLen:(document.body&&document.body.innerText||'').length,html:(document.documentElement.outerHTML||'').length,scripts:document.querySelectorAll('script').length,videos:document.querySelectorAll('video').length,webdriver:navigator.webdriver,ua:navigator.userAgent.slice(0,60),mediaCapabilities:typeof navigator.requestMediaKeySystemAccess})`,
  returnByValue: true,
}, sessionId).catch(() => ({ result: { value: 'evalerr' } }));
console.log('\n--- final DOM ---', JSON.stringify(result?.value));
console.log(`net-fails total: ${failCount}`);

try { await send(ws, pending, 'Target.closeTarget', { targetId }); } catch {}
ws.close();
process.exit(0);
