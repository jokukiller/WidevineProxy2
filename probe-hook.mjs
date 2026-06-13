// probe-hook.mjs — is the WidevineProxy2 MAIN-world EME hook actually installed
// on a freshly-loaded watch page, and does MediaKeySession.update get called?
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { ensurePlayableWatchUrl } from '../../codespaces/pi-pipeline/src/watch-url.mjs';
const PORT=process.env.CDP_PORT||9222,HOST='127.0.0.1';
const childId=process.argv[2]||'69a00bd50e6503b008fec1ad';
const placements=JSON.parse(readFileSync('../crawler-output/pi-placements.json','utf8'));
const url=ensurePlayableWatchUrl(placements.find(x=>x.childId===childId).watchUrl);
async function hj(p){return (await fetch(`http://${HOST}:${PORT}${p}`)).json();}
function mk(ws,pend){return(m,pa={},s)=>{const id=mk._id=(mk._id||0)+1;const pl={id,method:m,params:pa};if(s)pl.sessionId=s;return new Promise((r,j)=>{pend.set(id,{resolve:r,reject:j});ws.send(JSON.stringify(pl));});};}
const v=await hj('/json/version');const ws=new WebSocket(v.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
const pend=new Map();const ls=[];ws.on('message',b=>{const m=JSON.parse(b);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}else if(m.method){for(const l of ls)l(m);}});
const S=mk(ws,pend);
const {targetId}=await S('Target.createTarget',{url});
const sess=(await S('Target.attachToTarget',{targetId,flatten:true})).sessionId;
await S('Page.enable',{},sess).catch(()=>{});await S('Runtime.enable',{},sess).catch(()=>{});
ls.push(m=>{if(m.sessionId===sess&&m.method==='Page.javascriptDialogOpening')S('Page.handleJavaScriptDialog',{accept:true},sess).catch(()=>{});});
// capture page console for [WidevineProxy2]/[WVP2-Capture] markers
ls.push(m=>{if(m.sessionId!==sess)return;if(m.method==='Runtime.consoleAPICalled'){const a=(m.params.args||[]).map(x=>x.value??x.description??'').join(' ');if(/WVP2|WidevineProxy2|MediaKey|update|REQUEST|RESPONSE/i.test(a))console.log('[page]',a.slice(0,160));}});
await S('Page.bringToFront',{},sess).catch(()=>{});
await S('Emulation.setFocusEmulationEnabled',{enabled:true},sess).catch(()=>{});
// Instrument MediaKeySession.update to log whenever it's called (in addition to the extension's own proxy).
await S('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{try{const o=MediaKeySession.prototype.update;MediaKeySession.prototype.update=function(...a){console.log('[probe] MKS.update called, bytes='+(a[0]&&a[0].byteLength));return o.apply(this,a);};}catch(e){}})()`},sess).catch(()=>{});
await new Promise(r=>setTimeout(r,9000));
const check=`(()=>{try{return JSON.stringify({loaded:!!window.__widevineProxy2ContentScriptLoaded,updateFn:(MediaKeySession.prototype.update||'').toString().slice(0,80),updateProxied:!!(MediaKeySession.prototype.update&&MediaKeySession.prototype.update.__widevineProxy2Proxy),addElProxied:!!(EventTarget.prototype.addEventListener&&EventTarget.prototype.addEventListener.__widevineProxy2Proxy),hasMKSA:typeof navigator.requestMediaKeySystemAccess,vid:!!document.querySelector('video')});}catch(e){return 'e:'+e.message}})()`;
console.log('hook check:', await S('Runtime.evaluate',{expression:check,returnByValue:true},sess).then(r=>r.result.value));
// nudge + watch ~25s for update calls
for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,3000));await S('Runtime.evaluate',{expression:`(()=>{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}})()`,returnByValue:true},sess).catch(()=>{});}
await S('Target.closeTarget',{targetId}).catch(()=>{});ws.close();process.exit(0);
