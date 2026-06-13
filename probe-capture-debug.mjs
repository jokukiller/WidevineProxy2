// probe-capture-debug.mjs — instrument the live capture for ONE lecture.
// Opens the playable watch URL, forces playback, and every few seconds dumps the
// extension SW's storage *capture logs* (entries with a keys[] array), so we can
// see WHETHER and WHEN the extension captures {kid,key}, and under what key —
// independent of the harvester's reader/poll loop. Also times an isolated
// chrome.storage.local.get(null) to see if the 64MB snapshot makes it slow.
//
// Usage: node probe-capture-debug.mjs "<playableWatchUrl>" [secs]
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const EXT = 'pkoikjplcdkipeogmopelecfnfpaddcl';
const watchUrl = process.argv[2];
const secs = Number(process.argv[3] || 50);
if (!watchUrl) { console.error('usage: node probe-capture-debug.mjs "<url>" [secs]'); process.exit(2); }

async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);return r.json();}
function mk(ws,pending){return (m,p={},s)=>{const id=mk._id=(mk._id||0)+1;const pl={id,method:m,params:p};if(s)pl.sessionId=s;return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(pl));});};}
const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map(); const listeners=[];
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);}else if(m.method){for(const l of listeners)l(m);}});
const S = mk(ws,pending);

// Attach to the extension SW.
const { targetInfos } = await S('Target.getTargets');
const sw = targetInfos.find(t=>t.type==='service_worker' && (t.url||'').includes(EXT));
if(!sw){console.error('SW not found');process.exit(1);}
const swSession = (await S('Target.attachToTarget',{targetId:sw.targetId,flatten:true})).sessionId;
await S('Runtime.enable',{},swSession);
const swEval = async (e)=>{const r=await S('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},swSession).catch(err=>({result:{value:'SWERR:'+err.message}}));return r?.result?.value;};

// Time an isolated get(null) to see if the 64MB snapshot makes the reader slow.
{
  const t=Date.now();
  const sizes = await swEval(`(async()=>{const all=await chrome.storage.local.get(null);const keys=Object.keys(all);const big=keys.map(k=>[k,JSON.stringify(all[k]).length]).sort((a,b)=>b[1]-a[1]).slice(0,6);return JSON.stringify({keyCount:keys.length,biggest:big});})()`);
  console.log(`SW storage.get(null) took ${Date.now()-t}ms ->`, sizes);
}

// Open a fresh tab to the playable URL, auto-accept dialogs, force playback.
const pageSession = (await S('Target.attachToTarget',{targetId:(await S('Target.createTarget',{url:'about:blank'})).targetId,flatten:true})).sessionId;
await S('Page.enable',{},pageSession).catch(()=>{});
await S('Runtime.enable',{},pageSession).catch(()=>{});
listeners.push((m)=>{ if(m.sessionId===pageSession && m.method==='Page.javascriptDialogOpening'){S('Page.handleJavaScriptDialog',{accept:true},pageSession).catch(()=>{});} });
await S('Page.bringToFront',{},pageSession).catch(()=>{});
console.log('navigating ->', watchUrl.slice(0,90)+'...');
await S('Page.navigate',{url:watchUrl},pageSession);

const nudge = `(()=>{try{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}return v?{rs:v.readyState,ct:+v.currentTime.toFixed(1),paused:v.paused}:null;}catch(e){return 'e:'+e.message}})()`;
// Dump only capture-log-shaped entries (have a keys[] array); never the snapshot.
const dumpCaptures = `(async()=>{const all=await chrome.storage.local.get(null);const out=[];for(const [k,v] of Object.entries(all)){if(v&&typeof v==='object'&&Array.isArray(v.keys)&&v.keys.length){out.push({storageKey:k.slice(0,40),type:v.type,url:(v.url||'').slice(0,70),keys:v.keys.map(x=>({kid:x.kid,k:(x.k||'').slice(0,8)+'...'}))});}}return JSON.stringify(out);})()`;

for (let i=0;i<Math.floor(secs/5);i++){
  await new Promise(r=>setTimeout(r,5000));
  const v = await S('Runtime.evaluate',{expression:nudge,awaitPromise:true,returnByValue:true},pageSession).then(r=>r?.result?.value).catch(()=>'evalerr');
  const caps = await swEval(dumpCaptures);
  console.log(`t+${(i+1)*5}s video=${JSON.stringify(v)} captures=${caps}`);
}

await S('Target.closeTarget',{targetId: (await S('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!t.url.includes('chrome-extension')&&t.url.includes('pw.live'))?.targetId}).catch(()=>{});
ws.close(); process.exit(0);
