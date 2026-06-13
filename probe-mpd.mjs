// probe-mpd.mjs — resolve a childId via video-url-details (SW token) and decode
// the DASH manifest's ContentProtection to settle ClearKey vs Widevine.
// Usage: node probe-mpd.mjs <childId>
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const childId = process.argv[2];
if (!childId) { console.error('Usage: node probe-mpd.mjs <childId>'); process.exit(2); }

async function httpJson(p) { const r = await fetch(`http://${HOST}:${PORT}${p}`); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
const pending = new Map();
function send(ws, method, params = {}, sessionId) {
  const id = send._id = (send._id || 0) + 1;
  const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify(payload)); });
}
const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
ws.on('message', (buf) => { const m = JSON.parse(buf.toString()); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } });

const { targetInfos } = await send(ws, 'Target.getTargets');
let sw = targetInfos.find(t => t.type === 'service_worker' && /pkoikjpl/.test(t.url));
if (!sw) { console.error('extension SW not found; open the panel once to wake it'); process.exit(2); }
const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId: sw.targetId, flatten: true });
await send(ws, 'Runtime.enable', {}, sessionId);

const evalSW = async (expr) => {
  const { result, exceptionDetails } = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || JSON.stringify(exceptionDetails));
  return result.value;
};

const vud = await evalSW(`(async()=>{
  const s = await chrome.storage.local.get('pwAuthToken'); const a = s.pwAuthToken;
  if (!a || !a.token) return { error: 'no token' };
  const headers = { ...(a.capturedHeaders||{}), Authorization: 'Bearer '+a.token };
  const u = 'https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId=${childId}&clientVersion=201';
  const r = await fetch(u, { headers });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j || t };
})()`);
console.log('video-url-details status:', vud.status);
if (!vud.body || !vud.body.data) { console.log(JSON.stringify(vud, null, 2)); process.exit(0); }
const d = vud.body.data;
console.log('  videoId:', d.videoId, ' container:', d.videoContainer, ' cdn:', d.cdnType);
const mpdUrl = d.url + (d.signedUrl || '');
console.log('  mpdUrl:', mpdUrl.slice(0, 120) + '...');

// Decode Policy expiry
try {
  const pol = /Policy=([^&]+)/.exec(d.signedUrl)[1];
  const js = JSON.parse(Buffer.from(pol, 'base64').toString('utf8'));
  const exp = js.Statement[0].Condition.DateLessThan['AWS:EpochTime'];
  console.log('  signature expiry epoch:', exp, '=> ', new Date(exp * 1000).toISOString(), ` (~${Math.round((exp - d.serverTime/1000)/3600)}h from serverTime)`);
} catch (e) { console.log('  (could not decode Policy)', e.message); }

// Fetch the manifest (CloudFront, no auth) and inspect ContentProtection
const mr = await fetch(mpdUrl);
const mpd = await mr.text();
console.log('\nMPD status:', mr.status, ' length:', mpd.length);

const cps = [...mpd.matchAll(/<ContentProtection[\s\S]*?(?:\/>|<\/ContentProtection>)/g)].map(m => m[0]);
console.log('\nContentProtection elements:', cps.length);
for (const c of cps.slice(0, 12)) console.log('  ', c.replace(/\s+/g, ' ').slice(0, 400));

for (const m of [...mpd.matchAll(/schemeIdUri="([^"]+)"/g)]) { /* listed above */ }
const schemes = [...new Set([...mpd.matchAll(/schemeIdUri="([^"]+)"/g)].map(m => m[1]))];
console.log('\nDistinct schemeIdUri:', JSON.stringify(schemes, null, 2));

const kids = [...new Set([...mpd.matchAll(/(?:cenc:)?default_KID="([^"]+)"/g)].map(m => m[1]))];
console.log('default_KID(s):', kids);
const lic = [...new Set([...mpd.matchAll(/(?:licenseUrl|laUrl|LA_URL|licenseServerUrl)[^"]*"([^"]+)"/gi)].map(m => m[1]))];
console.log('license URLs in mpd:', lic.length ? lic : '(none — keys likely delivered out-of-band)');
const psshs = [...mpd.matchAll(/<cenc:pssh>([\s\S]*?)<\/cenc:pssh>/g)].map(m => m[1].trim());
console.log('cenc:pssh blocks:', psshs.length);
for (const p of psshs.slice(0, 4)) {
  console.log('  pssh b64 len', p.length, '->', p.slice(0, 60));
  try {
    const raw = Buffer.from(p, 'base64');
    // Widevine systemId bytes
    const hex = raw.toString('hex');
    console.log('    systemId hex window:', hex.slice(16, 48));
  } catch {}
}
ws.close();
