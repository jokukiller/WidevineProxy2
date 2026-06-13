// probe-extids.mjs — identify every loaded extension by attaching to its
// background context and reading chrome.runtime.getManifest() (name/version/
// description/permissions). Helps spot a conflicting EME/video/adblock extension.
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
async function httpJson(p){ const r=await fetch(`http://${HOST}:${PORT}${p}`); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function send(ws,pending,method,params={},sessionId){ const id=send._id=(send._id||0)+1; const payload={id,method,params}; if(sessionId)payload.sessionId=sessionId; return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(payload));}); }

const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map();
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString()); if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id); if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);}});

const { targetInfos } = await send(ws,pending,'Target.getTargets');
// One background target per extension id (service_worker or background_page).
const seen=new Set(); const targets=[];
for(const t of targetInfos){
  const m=/chrome-extension:\/\/([a-p]{32})/.exec(t.url||'');
  if(m && (t.type==='service_worker'||t.type==='background_page') && !seen.has(m[1])){ seen.add(m[1]); targets.push({id:m[1],t}); }
}

for(const {id,t} of targets){
  try{
    const { sessionId } = await send(ws,pending,'Target.attachToTarget',{targetId:t.targetId,flatten:true});
    await send(ws,pending,'Runtime.enable',{},sessionId).catch(()=>{});
    const { result, exceptionDetails } = await send(ws,pending,'Runtime.evaluate',{
      expression:`(()=>{try{const m=chrome.runtime.getManifest();return JSON.stringify({name:m.name,version:m.version,description:(m.description||'').slice(0,100),perms:(m.permissions||[]).slice(0,20),host:(m.host_permissions||[]).slice(0,8)});}catch(e){return 'ERR:'+e.message;}})()`,
      returnByValue:true,
    },sessionId).catch(e=>({result:{value:'EVALERR:'+e.message}}));
    console.log(`\n[${id}] (${t.type})`);
    console.log('  ' + (exceptionDetails ? 'EXC' : (result?.value || '?')));
  }catch(e){ console.log(`\n[${id}] attach failed: ${e.message}`); }
}
ws.close();
process.exit(0);
