// probe-foreground.mjs — test the hypothesis that the PW player only initializes
// in a FOREGROUND/visible tab. Create a tab, ACTIVATE it (bring to front),
// emulate focus, nudge play, and watch for (a) video-url-details being called,
// (b) a <video> element appearing, (c) a NEW key landing in the extension store.
//
// Usage: node probe-foreground.mjs "<watchUrl>" [secs] [extId]
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const watchUrl = process.argv[2];
const secs = Number(process.argv[3] || 60);
const extId = process.argv[4] || 'pkoikjplcdkipeogmopelecfnfpaddcl';
if (!watchUrl) { console.error('Usage: node probe-foreground.mjs "<watchUrl>" [secs] [extId]'); process.exit(2); }

async function httpJson(p){ const r=await fetch(`http://${HOST}:${PORT}${p}`); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function send(ws,pending,method,params={},sessionId){ const id=send._id=(send._id||0)+1; const payload={id,method,params}; if(sessionId)payload.sessionId=sessionId; return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(payload));}); }

const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false, maxPayload:64*1024*1024});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map(); const listeners=[];
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString()); if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id); if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);} else if(m.method){for(const l of listeners)l(m);}});

// attach extension SW for storage polling
let { targetInfos } = await send(ws,pending,'Target.getTargets');
let sw = targetInfos.find(t=>t.type==='service_worker' && (t.url||'').includes(extId));
let swSid = null;
if(sw){ ({ sessionId: swSid } = await send(ws,pending,'Target.attachToTarget',{targetId:sw.targetId,flatten:true})); await send(ws,pending,'Runtime.enable',{},swSid).catch(()=>{}); }
async function storeKeyCount(){
  if(!swSid) return -1;
  const { result } = await send(ws,pending,'Runtime.evaluate',{expression:`(async()=>{const a=await chrome.storage.local.get(null);return Object.values(a).filter(v=>v&&typeof v==='object'&&Array.isArray(v.keys)&&v.keys.length).length;})()`,awaitPromise:true,returnByValue:true},swSid).catch(()=>({result:{value:-1}}));
  return result?.value;
}
const beforeKeys = await storeKeyCount();

// fresh tab
const { targetId } = await send(ws,pending,'Target.createTarget',{url:'about:blank'});
const { sessionId } = await send(ws,pending,'Target.attachToTarget',{targetId,flatten:true});
await send(ws,pending,'Network.enable',{},sessionId).catch(()=>{});
await send(ws,pending,'Page.enable',{},sessionId).catch(()=>{});
await send(ws,pending,'Runtime.enable',{},sessionId).catch(()=>{});
listeners.push((m)=>{ if(m.sessionId===sessionId && m.method==='Page.javascriptDialogOpening'){ send(ws,pending,'Page.handleJavaScriptDialog',{accept:true},sessionId).catch(()=>{});}});

// network watch for the stream-resolution + key endpoints
const hits = { videoUrlDetails:0, videoDetails:0, getOtp:0, mpd:0, license:0 };
listeners.push((m)=>{
  if(m.sessionId!==sessionId) return;
  if(m.method!=='Network.requestWillBeSent') return;
  const u = m.params?.request?.url || '';
  if(u.includes('video-url-details')) hits.videoUrlDetails++;
  else if(u.includes('/video/details/')) hits.videoDetails++;
  else if(u.includes('get-otp')) hits.getOtp++;
  else if(u.includes('.mpd')) hits.mpd++;
  else if(/license|widevine|drm|\/ck\b/i.test(u)) hits.license++;
});

// THE TEST: activate (foreground) the tab + emulate focus so the player thinks it is visible.
await send(ws,pending,'Page.navigate',{url:watchUrl},sessionId);
await send(ws,pending,'Target.activateTarget',{targetId}).catch(()=>{});
await send(ws,pending,'Emulation.setFocusEmulationEnabled',{enabled:true},sessionId).catch(()=>{});

const NUDGE=`(()=>{try{const v=document.querySelector('video'); if(v){v.muted=true;const p=v.play&&v.play();if(p&&p.catch)p.catch(()=>{});} const b=document.querySelector('button[aria-label*="lay" i],[class*="play" i],.vjs-big-play-button,button'); b&&b.click&&b.click(); return {hasVideo:!!v, vis:document.visibilityState, hasFocus:document.hasFocus(), rs:v?v.readyState:-1, ct:v?+v.currentTime.toFixed(1):-1};}catch(e){return 'err:'+e.message}})()`;

for(let i=0;i<Math.floor(secs/5);i++){
  await new Promise(r=>setTimeout(r,5000));
  const { result } = await send(ws,pending,'Runtime.evaluate',{expression:NUDGE,awaitPromise:true,returnByValue:true,userGesture:true},sessionId).catch(()=>({result:{value:'evalerr'}}));
  const nowKeys = await storeKeyCount();
  console.log(`t+${(i+1)*5}s state=${JSON.stringify(result?.value)} net=${JSON.stringify(hits)} storeKeys=${beforeKeys}->${nowKeys}`);
  if(nowKeys>beforeKeys){ console.log('\n*** NEW KEY CAPTURED — foreground playback triggered EME ***'); break; }
}

try{ await send(ws,pending,'Target.closeTarget',{targetId}); }catch{}
ws.close();
process.exit(0);
