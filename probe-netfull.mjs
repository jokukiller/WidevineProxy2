// probe-netfull.mjs — fresh tab -> watchUrl, log EVERY penpencil/cloudfront/
// media request (method, url, status, or failure) to see exactly where the
// player stalls. Forces the tab visible/focused.
//
// Usage: node probe-netfull.mjs "<watchUrl>" [secs]
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const watchUrl = process.argv[2]; const secs = Number(process.argv[3] || 30);
if (!watchUrl) { console.error('usage'); process.exit(2); }
async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);return r.json();}
function send(ws,pending,method,params={},sessionId){const id=send._id=(send._id||0)+1;const pl={id,method,params};if(sessionId)pl.sessionId=sessionId;return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(pl));});}
const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map(); const listeners=[];
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);}else if(m.method){for(const l of listeners)l(m);}});
const { targetId } = await send(ws,pending,'Target.createTarget',{url:'about:blank'});
const { sessionId } = await send(ws,pending,'Target.attachToTarget',{targetId,flatten:true});
await send(ws,pending,'Page.enable',{},sessionId).catch(()=>{});
await send(ws,pending,'Runtime.enable',{},sessionId).catch(()=>{});
await send(ws,pending,'Network.enable',{},sessionId).catch(()=>{});
listeners.push((m)=>{ if(m.sessionId!==sessionId)return; if(m.method==='Page.javascriptDialogOpening'){send(ws,pending,'Page.handleJavaScriptDialog',{accept:true},sessionId).catch(()=>{});} });

const KEEP=/penpencil\.co|cloudfront|\.mpd|\.m4s|license|otp|drm|videodelivery|media/i;
const reqs=new Map();
listeners.push((m)=>{ if(m.sessionId!==sessionId)return; const p=m.params||{};
  if(m.method==='Network.requestWillBeSent'){const u=p.request?.url||''; if(!KEEP.test(u))return; reqs.set(p.requestId,{u,method:p.request.method}); console.log(`REQ ${p.request.method} ${u.slice(0,120)}`);}
  else if(m.method==='Network.responseReceived'){const r=reqs.get(p.requestId); if(!r)return; const u=p.response?.url||r.u; if(!KEEP.test(u))return; console.log(`  RES ${p.response.status} ${u.slice(0,90)}`);}
  else if(m.method==='Network.loadingFailed'){const r=reqs.get(p.requestId); if(!r)return; console.log(`  FAIL ${p.errorText} ${r.u.slice(0,90)}`);}
});

await send(ws,pending,'Page.bringToFront',{},sessionId).catch(()=>{});
await send(ws,pending,'Emulation.setFocusEmulationEnabled',{enabled:true},sessionId).catch(()=>{});
console.log(`Navigating -> ${watchUrl}\n--- penpencil/media network ---`);
await send(ws,pending,'Page.navigate',{url:watchUrl},sessionId);
const evalIn=async(e)=>{const r=await send(ws,pending,'Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true},sessionId).catch(()=>({result:{}}));return r?.result?.value;};
for(let i=0;i<Math.floor(secs/3);i++){ await new Promise(r=>setTimeout(r,3000)); await evalIn(`(()=>{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}const b=document.querySelector('[class*="play" i],button');b&&b.click&&b.click();})()`); }
try{await send(ws,pending,'Target.closeTarget',{targetId});}catch{}
ws.close(); process.exit(0);
