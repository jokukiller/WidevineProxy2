// probe-auth.mjs — read the pw.live page localStorage to find the refresh token,
// randomId, and access token (read-only; no navigation).
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
const pending=new Map();
function send(ws,method,params={},sessionId){const id=send._id=(send._id||0)+1;const pl={id,method,params};if(sessionId)pl.sessionId=sessionId;return new Promise((res,rej)=>{pending.set(id,{res,rej});ws.send(JSON.stringify(pl));});}
const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const {targetInfos}=await send(ws,'Target.getTargets');
const page=targetInfos.find(t=>t.type==='page'&&/pw\.live/.test(t.url));
if(!page){console.error('No pw.live tab open. Open https://www.pw.live/study-v2/pi');process.exit(2);}
const {sessionId}=await send(ws,'Target.attachToTarget',{targetId:page.targetId,flatten:true});
await send(ws,'Runtime.enable',{},sessionId);
const evalP=async(expr)=>{const{result,exceptionDetails}=await send(ws,'Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true},sessionId);if(exceptionDetails)throw new Error(exceptionDetails.exception?.description||'eval err');return result.value;};

const out = await evalP(`(()=>{
  const keys = Object.keys(localStorage);
  const interesting = {};
  const mask = (v)=> typeof v==='string' && v.length>60 ? v.slice(0,20)+'...('+v.length+' chars)' : v;
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (/tok|refresh|random|auth|user|jwt|session|device/i.test(k) || /eyJ|refresh/i.test(v||'')) {
      // try to parse JSON and surface token-ish subfields
      let parsed=null; try{parsed=JSON.parse(v);}catch{}
      if (parsed && typeof parsed==='object') {
        const sub={}; for (const kk of Object.keys(parsed)) sub[kk]= mask(typeof parsed[kk]==='object'?JSON.stringify(parsed[kk]):String(parsed[kk]));
        interesting[k]=sub;
      } else interesting[k]=mask(v);
    }
  }
  return { allKeys: keys, interesting };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
