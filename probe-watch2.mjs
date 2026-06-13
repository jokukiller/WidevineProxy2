// probe-watch2.mjs — like probe-watch-state but forces the tab visible/focused
// (Page.bringToFront + Emulation.setFocusEmulationEnabled) and dumps the real
// rendered DOM structure, to find why the PW player never creates a <video>.
//
// Usage: node probe-watch2.mjs "<watchUrl>" [secs]
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
// Network: log stream-resolution / drm calls.
listeners.push((m)=>{ if(m.sessionId!==sessionId)return; const p=m.params||{}; if(m.method==='Network.requestWillBeSent'){const u=p.request?.url||''; if(/video-url-details|get-otp|video\/details|\.mpd|license|cloudfront/i.test(u)) console.log('  [net]',p.request.method,u.slice(0,110));}});

// Force the tab to be foreground + focused BEFORE navigation (players gate on visibility).
await send(ws,pending,'Target.activateTarget',{targetId}).catch(()=>{});
await send(ws,pending,'Page.bringToFront',{},sessionId).catch(()=>{});
await send(ws,pending,'Emulation.setFocusEmulationEnabled',{enabled:true},sessionId).catch(()=>{});

console.log(`Navigating -> ${watchUrl}`);
await send(ws,pending,'Page.navigate',{url:watchUrl},sessionId);

const evalIn = async (expr) => { const r = await send(ws,pending,'Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true},sessionId).catch(e=>({result:{value:'EVALERR:'+e.message}})); return r?.result?.value; };

const NUDGE = `(()=>{try{const v=document.querySelector('video');if(v){v.muted=true;const p=v.play&&v.play();if(p&&p.catch)p.catch(()=>{});}const el=document.querySelector('.vjs-big-play-button,[class*="play" i],button');el&&el.click&&el.click();return !!v;}catch(e){return 'e:'+e.message}})()`;
const DOM = `(()=>{try{
  const vis=document.visibilityState; const focus=document.hasFocus();
  const all=document.querySelectorAll('*').length;
  const tags={};[...document.querySelectorAll('body *')].slice(0,4000).forEach(e=>{const t=e.tagName.toLowerCase();tags[t]=(tags[t]||0)+1;});
  const top=Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,12);
  const cls=[...document.querySelectorAll('[class]')].slice(0,40).map(e=>e.className&&e.className.toString&&e.className.toString().slice(0,40)).filter(Boolean);
  const txt=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0,200);
  return JSON.stringify({vis,focus,allEls:all,videos:document.querySelectorAll('video').length,topTags:top,bodyText:txt,sampleClasses:[...new Set(cls)].slice(0,15)});
}catch(e){return 'ERR:'+e.message}})()`;

for (let i=0;i<Math.floor(secs/5);i++){
  await new Promise(r=>setTimeout(r,5000));
  await evalIn(NUDGE);
  await send(ws,pending,'Page.bringToFront',{},sessionId).catch(()=>{});
  console.log(`t+${(i+1)*5}s`, await evalIn(DOM));
}
try{await send(ws,pending,'Target.closeTarget',{targetId});}catch{}
ws.close(); process.exit(0);
