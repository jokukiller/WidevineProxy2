// probe-extstore.mjs — dump the WidevineProxy2 extension's chrome.storage.local
// keys and any captured license/key logs (entries carrying a `keys` array),
// to confirm whether the extension is actually capturing {kid,key} at all.
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';
const extId = process.argv[2] || 'pkoikjplcdkipeogmopelecfnfpaddcl';
async function httpJson(p){ const r=await fetch(`http://${HOST}:${PORT}${p}`); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
function send(ws,pending,method,params={},sessionId){ const id=send._id=(send._id||0)+1; const payload={id,method,params}; if(sessionId)payload.sessionId=sessionId; return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(payload));}); }

const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false, maxPayload: 64*1024*1024});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map();
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString()); if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id); if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);}});

// Wake + attach the extension SW (open panel if needed).
let { targetInfos } = await send(ws,pending,'Target.getTargets');
let sw = targetInfos.find(t=>t.type==='service_worker' && (t.url||'').includes(extId));
if(!sw){
  await send(ws,pending,'Target.createTarget',{url:`chrome-extension://${extId}/panel/panel.html`});
  await new Promise(r=>setTimeout(r,1500));
  ({ targetInfos } = await send(ws,pending,'Target.getTargets'));
  sw = targetInfos.find(t=>t.type==='service_worker' && (t.url||'').includes(extId));
}
if(!sw){ console.log('could not find/wake extension SW'); ws.close(); process.exit(1); }
const { sessionId } = await send(ws,pending,'Target.attachToTarget',{targetId:sw.targetId,flatten:true});
await send(ws,pending,'Runtime.enable',{},sessionId).catch(()=>{});

const EXPR = `(async()=>{
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all);
  const out = { totalKeys: keys.length, keyNames: keys.slice(0,40), licenseLogs: [] };
  for (const [k,v] of Object.entries(all)) {
    // A captured license/key log carries a keys[] array of {k,kid,...} (and usually a url + type).
    if (v && typeof v==='object' && Array.isArray(v.keys) && v.keys.length) {
      out.licenseLogs.push({
        storageKey: k,
        url: (v.url||'').slice(0,90),
        type: v.type,
        nKeys: v.keys.length,
        firstKey: v.keys[0] ? { kid: v.keys[0].kid, k: (v.keys[0].k||'').slice(0,6)+'…', kty: v.keys[0].kty } : null,
        timestamp: v.timestamp,
      });
    }
  }
  // Also surface any array-valued top-level logs (some builds store a history array).
  for (const [k,v] of Object.entries(all)) {
    if (Array.isArray(v) && v.length && v[0] && (v[0].keys || v[0].pssh_data)) {
      out.licenseLogs.push({ storageKey: k+'[array]', n: v.length, sample: { url:(v[0].url||'').slice(0,90), type:v[0].type, nKeys:(v[0].keys||[]).length } });
    }
  }
  return out;
})()`;
const { result, exceptionDetails } = await send(ws,pending,'Runtime.evaluate',{expression:EXPR,awaitPromise:true,returnByValue:true},sessionId).catch(e=>({result:{value:'EVALERR:'+e.message}}));
console.log(exceptionDetails ? ('EXC:'+JSON.stringify(exceptionDetails).slice(0,400)) : JSON.stringify(result.value,null,1));
ws.close();
process.exit(0);
