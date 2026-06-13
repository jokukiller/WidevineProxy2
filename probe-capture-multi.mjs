// probe-capture-multi.mjs — for each childId: open the playable watch URL in a
// focused/foreground fresh tab, report the resume position (ct), count
// MediaKeySession.update() calls, and check whether the extension captured a
// key. Distinguishes never-watched (ct~0, fresh license) from resumed.
//
// Usage: node probe-capture-multi.mjs <childId...>
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { ensurePlayableWatchUrl } from '../../codespaces/pi-pipeline/src/watch-url.mjs';
const PORT=process.env.CDP_PORT||9222,HOST='127.0.0.1',EXT='pkoikjplcdkipeogmopelecfnfpaddcl';
const childIds=process.argv.slice(2);
const placements=JSON.parse(readFileSync('../crawler-output/pi-placements.json','utf8'));
const byId=new Map(placements.map(p=>[p.childId,p]));
async function hj(p){return (await fetch(`http://${HOST}:${PORT}${p}`)).json();}
function mk(ws,pend){return(m,pa={},s)=>{const id=mk._id=(mk._id||0)+1;const pl={id,method:m,params:pa};if(s)pl.sessionId=s;return new Promise((r,j)=>{pend.set(id,{resolve:r,reject:j});ws.send(JSON.stringify(pl));});};}
const v=await hj('/json/version');const ws=new WebSocket(v.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
const pend=new Map();const ls=[];ws.on('message',b=>{const m=JSON.parse(b);if(m.id&&pend.has(m.id)){const{resolve,reject}=pend.get(m.id);pend.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}else if(m.method){for(const l of ls)l(m);}});
const S=mk(ws,pend);
const {targetInfos}=await S('Target.getTargets');
const sw=targetInfos.find(t=>t.type==='service_worker'&&(t.url||'').includes(EXT));
const swSession=(await S('Target.attachToTarget',{targetId:sw.targetId,flatten:true})).sessionId;
await S('Runtime.enable',{},swSession);
const swEval=async e=>{const r=await S('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true},swSession).catch(()=>({result:{}}));return r?.result?.value;};

async function tryOne(childId){
  const pl=byId.get(childId); if(!pl){console.log(childId,'NOT FOUND');return;}
  const url=ensurePlayableWatchUrl(pl.watchUrl);
  const {targetId}=await S('Target.createTarget',{url});
  const sess=(await S('Target.attachToTarget',{targetId,flatten:true})).sessionId;
  await S('Page.enable',{},sess).catch(()=>{});await S('Runtime.enable',{},sess).catch(()=>{});
  ls.push(m=>{if(m.sessionId===sess&&m.method==='Page.javascriptDialogOpening')S('Page.handleJavaScriptDialog',{accept:true},sess).catch(()=>{});});
  await S('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__updCalls=0;(()=>{try{const o=MediaKeySession.prototype.update;MediaKeySession.prototype.update=function(...a){globalThis.__updCalls++;return o.apply(this,a);};}catch(e){}})()`},sess).catch(()=>{});
  await S('Page.bringToFront',{},sess).catch(()=>{});
  await S('Emulation.setFocusEmulationEnabled',{enabled:true},sess).catch(()=>{});
  let firstCt=null, cap=null, upd=0;
  for(let i=0;i<7;i++){
    await new Promise(r=>setTimeout(r,3000));
    const st=await S('Runtime.evaluate',{expression:`(()=>{const v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play().catch(()=>{});}return JSON.stringify({ct:v?+v.currentTime.toFixed(1):null,upd:globalThis.__updCalls||0});})()`,awaitPromise:true,returnByValue:true},sess).then(r=>{try{return JSON.parse(r.result.value);}catch{return{};}}).catch(()=>({}));
    if(firstCt===null && st.ct!=null) firstCt=st.ct;
    upd=st.upd||upd;
    const c=JSON.parse((await swEval(`(async()=>{const all=await chrome.storage.local.get(null);for(const v of Object.values(all)){if(v&&Array.isArray(v.keys)&&v.keys.length&&(v.url||'').includes('${childId}'))return JSON.stringify({kid:v.keys[0].kid,type:v.type});}return 'null';})()`))||'null');
    if(c){cap=c;break;}
  }
  console.log(`${childId} | ${pl.subject.slice(0,22).padEnd(22)} | resumeCt=${firstCt} updCalls=${upd} | ${cap?('CAPTURED '+cap.type+' kid='+cap.kid):'no-capture'}`);
  await S('Target.closeTarget',{targetId}).catch(()=>{});
}
for(const cid of childIds){ try{await tryOne(cid);}catch(e){console.log(cid,'ERR',e.message);} }
ws.close();process.exit(0);
