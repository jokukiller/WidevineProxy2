// probe-refresh.mjs — validate the headless refresh-token flow & rotation.
// Runs in the pw.live page context (reads REFRESH_TOKEN from localStorage),
// POSTs /v3/oauth/refresh-token, and reports SHAPE only (no secret values).
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
  const oldToken = localStorage.getItem('TOKEN');
  const randomId = localStorage.getItem('randomId');
  if (!oldRefresh) return { error: 'no REFRESH_TOKEN in localStorage' };
  const body = { client_id:'system-admin', client_secret:'KjPXuAVfC5xbmgreETNMaL7z', refresh_token: oldRefresh };
  let r, txt, j;
  try {
    r = await fetch('https://api.penpencil.co/v3/oauth/refresh-token', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'client-type':'WEB', 'randomId': randomId||'' },
      body: JSON.stringify(body)
    });
    txt = await r.text(); try{ j = JSON.parse(txt); }catch{}
  } catch(e){ return { fetchError: e.message }; }
  const d = j && j.data || {};
  const newToken = d.access_token, newRefresh = d.refresh_token;
  return {
    httpStatus: r.status,
    success: j && j.success,
    rawShape: j ? Object.keys(j) : null,
    dataKeys: d ? Object.keys(d) : null,
    accessTokenReturned: !!newToken,
    accessTokenLen: newToken ? newToken.length : 0,
    accessTokenIsJwt: newToken ? /^eyJ/.test(newToken) : false,
    accessTokenChanged: !!newToken && newToken !== oldToken,
    refreshTokenReturned: !!newRefresh,
    refreshTokenRotated: !!newRefresh && newRefresh !== oldRefresh,
    expires_in: d.expires_in,
    errorIfAny: j && j.error ? j.error : (txt ? txt.slice(0,200) : null)
  };
})()`);
console.log(JSON.stringify(res, null, 2));
ws.close(); process.exit(0);
