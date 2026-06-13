// probe-fix-sw.mjs — try to recover a wedged extension service worker.
// Attaches to the target SW, interrupts its stuck execution, and re-tests a
// trivial eval to see whether it became responsive again.
//
// Usage: node probe-fix-sw.mjs <extIdSubstring>
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const ext = process.argv[2] || 'pkoikjplcdkipeogmopelecfnfpaddcl';

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
const race = (p, ms, tag) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout:' + tag)), ms))]);

const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const pending = new Map();
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
  }
});

const { targetInfos } = await send(ws, pending, 'Target.getTargets');
const sw = targetInfos.find(t => t.type === 'service_worker' && (t.url || '').includes(ext));
if (!sw) { console.log('no SW target for', ext); process.exit(1); }
console.log('SW target:', sw.targetId, sw.url);

const { sessionId } = await send(ws, pending, 'Target.attachToTarget', { targetId: sw.targetId, flatten: true });
console.log('attached session', sessionId);

// 1) Interrupt any stuck synchronous execution on the SW.
try {
  await race(send(ws, pending, 'Runtime.terminateExecution', {}, sessionId), 5000, 'terminate');
  console.log('terminateExecution: sent ok');
} catch (e) { console.log('terminateExecution:', e.message); }

// 2) Re-test responsiveness with a trivial eval.
async function tryEval(tag) {
  try {
    const r = await race(send(ws, pending, 'Runtime.evaluate', {
      expression: '1+1', returnByValue: true,
    }, sessionId), 6000, tag);
    console.log(`${tag}: responsive ->`, JSON.stringify(r?.result?.value));
    return true;
  } catch (e) { console.log(`${tag}:`, e.message); return false; }
}
const ok1 = await tryEval('eval-after-terminate');

// 3) If still responsive, ask the SW to reload the extension (clean respawn).
if (ok1) {
  try {
    await race(send(ws, pending, 'Runtime.evaluate', {
      expression: 'try{chrome.runtime.reload()}catch(e){e.message}', returnByValue: true,
    }, sessionId), 4000, 'reload');
    console.log('chrome.runtime.reload(): issued (SW will respawn)');
  } catch (e) { console.log('reload:', e.message, '(expected: SW dies mid-eval)'); }
}

ws.close();
process.exit(0);
