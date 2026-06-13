// probe-drm.mjs — for several childIds, resolve video-url-details and report
// EXACTLY which DRM systems each DASH manifest declares (Widevine vs ClearKey).
import { WebSocket } from 'ws';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';

const CHILD_IDS = [
  '699fe7fb0e6503b008feaffb', // CS/GATE - Divide & Conquer P1 (already tested)
  '699fe6710e6503b008feaf45', // CS - Dynamic Programming P4 (Algorithms log)
  '6a0ece969b83bdc732ed546f', // NEET Chemistry mindmap (with-playlist page)
  '6a041f28f621e3086b593083', // Physics - Motion in a Straight Line
  '695623bcc17f7ff7ac3d1dac', // Chemical Bonding
];
const SYS = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'ClearKey',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  'urn:mpeg:dash:mp4protection:2011': 'cenc(mp4protection)',
};

async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
const pending=new Map();
function send(ws,method,params={},sessionId){const id=send._id=(send._id||0)+1;const pl={id,method,params};if(sessionId)pl.sessionId=sessionId;return new Promise((res,rej)=>{pending.set(id,{res,rej});ws.send(JSON.stringify(pl));});}
const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:256*1024*1024});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});

const {targetInfos}=await send(ws,'Target.getTargets');
const sw=targetInfos.find(t=>t.type==='service_worker'&&/pkoikjpl/.test(t.url));
if(!sw){console.error('extension SW not found; open the panel to wake it');process.exit(2);}
const {sessionId}=await send(ws,'Target.attachToTarget',{targetId:sw.targetId,flatten:true});
await send(ws,'Runtime.enable',{},sessionId);
const evalSW=async(expr)=>{const{result,exceptionDetails}=await send(ws,'Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true},sessionId);if(exceptionDetails)throw new Error(exceptionDetails.exception?.description||'eval err');return result.value;};

for (const childId of CHILD_IDS) {
  try {
    const vud = await evalSW(`(async()=>{
      const a=(await chrome.storage.local.get('pwAuthToken')).pwAuthToken; if(!a||!a.token)return{error:'no token'};
      const headers={...(a.capturedHeaders||{}),Authorization:'Bearer '+a.token};
      const u='https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId=${childId}&clientVersion=201';
      const r=await fetch(u,{headers}); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{};
      return {status:r.status, body:j||t};
    })()`);
    console.log('\n==================', childId, '==================');
    if (!vud.body || !vud.body.data) { console.log('  video-url-details:', JSON.stringify(vud).slice(0,300)); continue; }
    const d = vud.body.data;
    const mpdUrl = d.url + (d.signedUrl||'');
    const mr = await fetch(mpdUrl); const mpd = await mr.text();
    const schemes = [...new Set([...mpd.matchAll(/schemeIdUri="([^"]+)"/g)].map(m=>m[1].replace(/^urn:uuid:/,'')))];
    const named = schemes.map(s=>SYS[s]||SYS['urn:uuid:'+s]||s);
    const kids = [...new Set([...mpd.matchAll(/default_KID="([^"]+)"/g)].map(m=>m[1]))];
    console.log('  videoContainer:', d.videoContainer, ' mpd len:', mpd.length);
    console.log('  DRM systems:', JSON.stringify(named));
    console.log('  default_KID:', kids);
    console.log('  Widevine present?', /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i.test(mpd));
    console.log('  PlayReady present?', /9a04f079-9840-4286-ab92-e65be0885f95/i.test(mpd));
  } catch (e) { console.log('\n==================', childId, '==================\n  ERROR', e.message); }
}
ws.close(); process.exit(0);
