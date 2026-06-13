// probe-refresh-restore.mjs — refresh once and WRITE BACK the new tokens into the
// page session (via the SDK setter) so the browser login stays valid after our
// earlier rotation. Reports masked status only.
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
if(!page){console.error('No pw.live tab open.');process.exit(2);}
const {sessionId}=await send(ws,'Target.attachToTarget',{targetId:page.targetId,flatten:true});
await send(ws,'Runtime.enable',{},sessionId);
const evalP=async(expr)=>{const{result,exceptionDetails}=await send(ws,'Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true},sessionId);if(exceptionDetails)throw new Error(exceptionDetails.exception?.description||'eval err');return result.value;};

const res = await evalP(`(async()=>{
  const oldRefresh = localStorage.getItem('REFRESH_TOKEN');
  const randomId = localStorage.getItem('randomId');
  const body = { client_id:'system-admin', client_secret:'KjPXuAVfC5xbmgreETNMaL7z', refresh_token: oldRefresh };
  let r = await fetch('https://api.penpencil.co/v3/oauth/refresh-token', {
    method:'POST', headers:{ 'Content-Type':'application/json','client-type':'WEB','randomId':randomId||'' }, body: JSON.stringify(body)
  });
  let j; try{ j = await r.json(); }catch{}
  if (!j || !j.data || !j.data.access_token) {
    return { restored:false, status:r.status, note:'refresh failed (old refresh likely already rotated). Access token still valid ~7d; re-login when it expires.' };
  }
  const d = j.data;
  // Write back via the SDK setter if available (persists localStorage + cookie context); else localStorage directly.
  try {
    if (window.PWWebSDK) {
      window.PWWebSDK.setTokenContext = { token:d.access_token, refresh_token:d.refresh_token, randomId, expires_in:d.expires_in };
    } else {
      localStorage.setItem('TOKEN', d.access_token);
      localStorage.setItem('REFRESH_TOKEN', d.refresh_token);
    }
  } catch(e) { return { restored:false, writeError:e.message }; }
  return { restored:true, status:r.status, usedSDK: !!window.PWWebSDK, accessLen:d.access_token.length, expires_in:d.expires_in };
})()`);
console.log(JSON.stringify(res, null, 2));
ws.close(); process.exit(0);
