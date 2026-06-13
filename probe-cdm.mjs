// probe-cdm.mjs — list all extension targets and test the EME/CDM directly on a
// fresh page, to see whether requestMediaKeySystemAccess for Widevine/ClearKey
// actually resolves (a black screen with no <video> + no video-url-details may
// be a CDM/EME failure or a conflicting EME-hooking extension).
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';

async function httpJson(path) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}
function send(ws, pending, method, params = {}, sessionId) {
  const id = send._id = (send._id || 0) + 1;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify(payload)); });
}

const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const pending = new Map();
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result); }
});

// 1) All extension targets (spot conflicting EME extensions).
const { targetInfos } = await send(ws, pending, 'Target.getTargets');
const exts = new Map();
for (const t of targetInfos) {
  const m = /chrome-extension:\/\/([a-p]{32})/.exec(t.url || '');
  if (m) { const id = m[1]; if (!exts.has(id)) exts.set(id, []); exts.get(id).push(`${t.type}:${(t.url||'').replace(/^chrome-extension:\/\/[a-p]{32}\//,'')||'/'}`); }
}
console.log('=== extensions with active targets ===');
for (const [id, parts] of exts) console.log(`  ${id}  [${parts.join(', ')}]`);
console.log('=== all targets (type:host) ===');
for (const t of targetInfos) { let host=''; try{host=new URL(t.url).host;}catch{} console.log(`  ${t.type}  ${host}  ${(t.title||'').slice(0,40)}`); }

// 2) Test the CDM on a neutral fresh page (about:blank can't do EME; use the pw origin).
const { targetId } = await send(ws, pending, 'Target.createTarget', { url: 'https://www.pw.live/favicon.ico' });
const { sessionId } = await send(ws, pending, 'Target.attachToTarget', { targetId, flatten: true });
await send(ws, pending, 'Runtime.enable', {}, sessionId).catch(() => {});
await new Promise(r => setTimeout(r, 2500));

const EME_TEST = `(async()=>{
  const out={};
  const cfgClear=[{initDataTypes:['keyids','cenc'],videoCapabilities:[{contentType:'video/mp4;codecs="avc1.42E01E"'}]}];
  const cfgWv=[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4;codecs="avc1.42E01E"',robustness:'SW_SECURE_CRYPTO'}]}];
  try{ const a=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',cfgClear); out.clearkey='ok:'+a.keySystem; }catch(e){ out.clearkey='FAIL:'+e.name+':'+e.message; }
  try{ const a=await navigator.requestMediaKeySystemAccess('com.widevine.alpha',cfgWv); out.widevine='ok:'+a.keySystem; }catch(e){ out.widevine='FAIL:'+e.name+':'+e.message; }
  out.emeHookPresent = !!(navigator.requestMediaKeySystemAccess && navigator.requestMediaKeySystemAccess.toString().indexOf('native code')===-1);
  out.rmksaSource = String(navigator.requestMediaKeySystemAccess).slice(0,120);
  return out;
})()`;
const { result, exceptionDetails } = await send(ws, pending, 'Runtime.evaluate', { expression: EME_TEST, awaitPromise: true, returnByValue: true }, sessionId).catch(e => ({ result: { value: 'EVALERR:' + e.message } }));
console.log('\n=== EME / CDM probe ===');
console.log(exceptionDetails ? ('EXC:' + JSON.stringify(exceptionDetails).slice(0, 300)) : JSON.stringify(result.value, null, 1));

try { await send(ws, pending, 'Target.closeTarget', { targetId }); } catch {}
ws.close();
process.exit(0);
