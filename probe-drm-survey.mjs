// probe-drm-survey.mjs — sample N childIds spread across pi-assets.json and tally
// which DRM each DASH manifest declares, to measure the real Widevine/ClearKey split.
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const N = Number(process.argv[2] || 60);

const assets = JSON.parse(readFileSync('../crawler-output/pi-assets.json', 'utf8'));
const step = Math.max(1, Math.floor(assets.length / N));
const sample = [];
for (let i = 0; i < assets.length && sample.length < N; i += step) sample.push(assets[i]);

async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
const pending=new Map();
function send(ws,method,params={},sessionId){const id=send._id=(send._id||0)+1;const pl={id,method,params};if(sessionId)pl.sessionId=sessionId;return new Promise((res,rej)=>{pending.set(id,{res,rej});ws.send(JSON.stringify(pl));});}
const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const {targetInfos}=await send(ws,'Target.getTargets');
let sw=targetInfos.find(t=>t.type==='service_worker'&&/pkoikjpl/.test(t.url));
if(!sw){
  // wake the idle MV3 service worker by opening the panel page
  try { await send(ws,'Target.createTarget',{url:'chrome-extension://pkoikjplcdkipeogmopelecfnfpaddcl/panel/panel.html'}); } catch {}
  await new Promise(r=>setTimeout(r,1500));
  const t2=await send(ws,'Target.getTargets');
  sw=t2.targetInfos.find(t=>t.type==='service_worker'&&/pkoikjpl/.test(t.url));
}
if(!sw){console.error('extension SW not found even after wake attempt');process.exit(2);}
const {sessionId}=await send(ws,'Target.attachToTarget',{targetId:sw.targetId,flatten:true});
await send(ws,'Runtime.enable',{},sessionId);
const evalSW=async(expr)=>{const{result,exceptionDetails}=await send(ws,'Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(exceptionDetails)throw new Error('eval err');return result.value;};

// ObjectId timestamp (first 4 hex bytes) -> Date
const oidDate = (id) => { try { return new Date(parseInt(id.slice(0,8),16)*1000).toISOString().slice(0,10); } catch { return '?'; } };

const tally = { Widevine:0, ClearKey:0, PlayReady:0, none:0, error:0 };
const byMonth = {}; // yyyy-mm -> {Widevine,ClearKey}
let n=0;
for (const a of sample) {
  const childId = a.childId;
  try {
    const r = await evalSW(`(async()=>{
      const au=(await chrome.storage.local.get('pwAuthToken')).pwAuthToken; if(!au||!au.token)return{e:'notoken'};
      const h={...(au.capturedHeaders||{}),Authorization:'Bearer '+au.token};
      const u='https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId=${childId}&clientVersion=201';
      const res=await fetch(u,{headers:h}); let j; try{j=await res.json()}catch{}; 
      if(!j||!j.data||!j.data.url) return {e:'novud:'+res.status};
      const m=await (await fetch(j.data.url+(j.data.signedUrl||''))).text();
      return { wv:/edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(m), ck:/1077efec-c0b2-4d02-ace3-3c1e52e2fb4b/i.test(m), pr:/9a04f079-9840-4286-ab92-e65be0885f95/i.test(m) };
    })()`);
    n++;
    let kind;
    if (r.e) { tally.error++; kind='ERR:'+r.e; }
    else if (r.wv) { tally.Widevine++; kind='Widevine'; }
    else if (r.ck) { tally.ClearKey++; kind='ClearKey'; }
    else if (r.pr) { tally.PlayReady++; kind='PlayReady'; }
    else { tally.none++; kind='none'; }
    const mon = oidDate(childId).slice(0,7);
    if (!r.e) { byMonth[mon] = byMonth[mon] || {Widevine:0,ClearKey:0,other:0}; byMonth[mon][kind==='Widevine'?'Widevine':kind==='ClearKey'?'ClearKey':'other']++; }
    console.log(`${String(n).padStart(3)} ${childId} created=${oidDate(childId)} -> ${kind}`);
  } catch (e) { tally.error++; console.log(`    ${childId} ERROR ${e.message}`); }
  await new Promise(r=>setTimeout(r,120));
}
console.log('\n===== TALLY (sample of', n, 'of', assets.length, 'assets) =====');
console.log(JSON.stringify(tally,null,2));
console.log('\n===== by created-month =====');
for (const k of Object.keys(byMonth).sort()) console.log('  ', k, JSON.stringify(byMonth[k]));
ws.close(); process.exit(0);
