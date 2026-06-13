// probe-capture-focus.mjs — test whether activating/focusing the capture tab
// makes the player actually play and the extension capture a key. Mimics the
// harness openLectureTab (Target.createTarget straight to the URL) but applies
// Page.bringToFront + Emulation.setFocusEmulationEnabled, then polls the SW
// storage for a capture log whose url contains THIS childId.
//
// Usage: node probe-capture-focus.mjs <childId> [mode] [secs]
//   mode: focusonly | front | both (default both)
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { ensurePlayableWatchUrl } from '../../codespaces/pi-pipeline/src/watch-url.mjs';

const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const EXT = 'pkoikjplcdkipeogmopelecfnfpaddcl';
const childId = process.argv[2] || '69a00bd50e6503b008fec1ad';
const mode = process.argv[3] || 'both';
const secs = Number(process.argv[4] || 45);

const placements = JSON.parse(readFileSync('../crawler-output/pi-placements.json','utf8'));
const p = placements.find(x=>x.childId===childId);
if(!p){console.error('not found');process.exit(2);}
const url = ensurePlayableWatchUrl(p.watchUrl);

async function httpJson(pth){const r=await fetch(`http://${HOST}:${PORT}${pth}`);return r.json();}
function mk(ws,pending){return (m,pa={},s)=>{const id=mk._id=(mk._id||0)+1;const pl={id,method:m,params:pa};if(s)pl.sessionId=s;return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(pl));});};}
const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map(); const listeners=[];
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);}else if(m.method){for(const l of listeners)l(m);}});
const S = mk(ws,pending);

const { targetInfos } = await S('Target.getTargets');
const sw = targetInfos.find(t=>t.type==='service_worker' && (t.url||'').includes(EXT));
const swSession = (await S('Target.attachToTarget',{targetId:sw.targetId,flatten:true})).sessionId;
await S('Runtime.enable',{},swSession);
const swEval = async(e)=>{const r=await S('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},swSession).catch(()=>({result:{}}));return r?.result?.value;};

// Harness-style: create tab DIRECTLY at the watch URL.
const { targetId } = await S('Target.createTarget',{url});
const pageSession = (await S('Target.attachToTarget',{targetId,flatten:true})).sessionId;
await S('Page.enable',{},pageSession).catch(()=>{});
await S('Runtime.enable',{},pageSession).catch(()=>{});
listeners.push((m)=>{ if(m.sessionId===pageSession && m.method==='Page.javascriptDialogOpening'){S('Page.handleJavaScriptDialog',{accept:true},pageSession).catch(()=>{});} });

if (mode==='both' || mode==='front') await S('Page.bringToFront',{},pageSession).catch(()=>{});
if (mode==='both' || mode==='focusonly') await S('Emulation.setFocusEmulationEnabled',{enabled:true},pageSession).catch(()=>{});

console.log(`mode=${mode} childId=${childId}\nurl=${url.slice(0,100)}...\n`);
const nudge = `(()=>{try{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}const b=document.querySelector('.vjs-big-play-button,[class*="play" i],button');b&&b.click&&b.click();return v?{rs:v.readyState,ct:+v.currentTime.toFixed(1),paused:v.paused,vis:document.visibilityState,foc:document.hasFocus()}:{noVideo:true,vis:document.visibilityState};}catch(e){return 'e:'+e.message}})()`;
const findCap = `(async()=>{const all=await chrome.storage.local.get(null);for(const v of Object.values(all)){if(v&&Array.isArray(v.keys)&&v.keys.length&&(v.url||'').includes('${childId}')){return JSON.stringify({hit:true,kid:v.keys[0].kid,type:v.type});}}return JSON.stringify({hit:false});})()`;

let captured=null;
for(let i=0;i<Math.floor(secs/3);i++){
  await new Promise(r=>setTimeout(r,3000));
  const v = await S('Runtime.evaluate',{expression:nudge,awaitPromise:true,returnByValue:true},pageSession).then(r=>r?.result?.value).catch(()=>'err');
  const cap = JSON.parse((await swEval(findCap)) || '{"hit":false}');
  console.log(`t+${(i+1)*3}s video=${JSON.stringify(v)} cap=${cap.hit?('CAPTURED kid='+cap.kid+' '+cap.type):'-'}`);
  if(cap.hit){captured=cap;break;}
}
console.log(captured?`\nSUCCESS: captured key for ${childId}`:`\nNO CAPTURE for ${childId}`);
await S('Target.closeTarget',{targetId}).catch(()=>{});
ws.close(); process.exit(captured?0:1);
