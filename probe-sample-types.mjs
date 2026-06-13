// probe-sample-types.mjs — sample diverse childIds across the catalog and ask
// the LIVE video-url-details endpoint (via the extension SW, with the captured
// JWT) what each resolves to: urlType, videoContainer, and whether a signed
// DASH manifest is produced. Answers "do all lectures share the same watch-URL
// type requirements, or do some differ?" with real data.
//
// Usage: node probe-sample-types.mjs [perSubject] [maxSubjects]
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
const EXT = 'pkoikjplcdkipeogmopelecfnfpaddcl';
const perSubject = Number(process.argv[2] || 1);
const maxSubjects = Number(process.argv[3] || 60);

const placements = JSON.parse(readFileSync('../crawler-output/pi-placements.json', 'utf8'));
// Build a diverse sample: a few childIds from each distinct subject, spread across branches.
const bySubject = new Map();
for (const p of placements) {
  const key = `${p.mainBranch} / ${p.subject}`;
  if (!bySubject.has(key)) bySubject.set(key, []);
  const arr = bySubject.get(key);
  if (arr.length < perSubject && p.childId) arr.push(p.childId);
}
const subjects = [...bySubject.keys()];
// Spread across subjects evenly up to maxSubjects.
const step = Math.max(1, Math.floor(subjects.length / maxSubjects));
const sample = [];
for (let i = 0; i < subjects.length && sample.length < maxSubjects * perSubject; i += step) {
  for (const cid of bySubject.get(subjects[i])) sample.push({ cid, subject: subjects[i] });
}
console.log(`Catalog: ${placements.length} placements, ${subjects.length} distinct subjects. Sampling ${sample.length} childIds.`);

async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);return r.json();}
function send(ws,pending,method,params={},sessionId){const id=send._id=(send._id||0)+1;const pl={id,method,params};if(sessionId)pl.sessionId=sessionId;return new Promise((res,rej)=>{pending.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify(pl));});}
const version = await httpJson('/json/version');
const ws = new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
const pending=new Map();
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);if(m.error)reject(new Error(JSON.stringify(m.error)));else resolve(m.result);}});
const S=(m,p={},s)=>send(ws,pending,m,p,s);
const { targetInfos } = await S('Target.getTargets');
const sw = targetInfos.find(t=>t.type==='service_worker' && (t.url||'').includes(EXT));
if(!sw){console.log('WidevineProxy2 SW not found');process.exit(1);}
const { sessionId } = await S('Target.attachToTarget',{targetId:sw.targetId,flatten:true});
await S('Runtime.enable',{},sessionId);

// In the SW: fetch video-url-details for a batch of childIds using the stored JWT.
const expr = (ids) => `(async()=>{
  const a=(await chrome.storage.local.get('pwAuthToken')).pwAuthToken;
  if(!a||!a.token) return JSON.stringify({error:'no token'});
  const headers={...(a.capturedHeaders||{}),Authorization:'Bearer '+a.token};
  const out=[];
  for(const cid of ${JSON.stringify(ids)}){
    try{
      const u='https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId='+cid+'&clientVersion=201';
      const r=await fetch(u,{headers});
      let j=null; try{j=await r.json();}catch{}
      const d=j&&j.data||{};
      out.push({cid, status:r.status, ok:!!(j&&j.success), urlType:d.urlType||null, container:d.videoContainer||null, hasSigned:!!d.signedUrl, cdn:d.cdnType||null, msg:(j&&!j.success)?(j.message||j.error||'').toString().slice(0,60):null});
    }catch(e){ out.push({cid, error:String(e.message||e).slice(0,60)}); }
  }
  return JSON.stringify(out);
})()`;

// Process in chunks to keep each eval bounded.
const CHUNK = 12;
const results = [];
for (let i = 0; i < sample.length; i += CHUNK) {
  const ids = sample.slice(i, i + CHUNK).map(s => s.cid);
  const r = await S('Runtime.evaluate', { expression: expr(ids), awaitPromise:true, returnByValue:true }, sessionId).catch(e=>({result:{value:'[]'}}));
  let arr=[]; try{arr=JSON.parse(r.result.value);}catch{}
  for(const row of arr) results.push(row);
  process.stdout.write(`\r  resolved ${results.length}/${sample.length}`);
}
process.stdout.write('\n');

// Tally.
const tally = { total: results.length, ok:0, fail:0, byUrlType:{}, byContainer:{}, byCdn:{}, failures:[] };
for (const r of results) {
  if (r.ok && r.hasSigned) { tally.ok++; tally.byUrlType[r.urlType||'(none)']=(tally.byUrlType[r.urlType||'(none)']||0)+1; tally.byContainer[r.container||'(none)']=(tally.byContainer[r.container||'(none)']||0)+1; tally.byCdn[r.cdn||'(none)']=(tally.byCdn[r.cdn||'(none)']||0)+1; }
  else { tally.fail++; if(tally.failures.length<20) tally.failures.push({cid:r.cid, status:r.status, msg:r.msg||r.error}); }
}
console.log('\n=== video-url-details (type=OTT, DASH) over the sample ===');
console.log(JSON.stringify(tally, null, 1));
ws.close(); process.exit(0);
