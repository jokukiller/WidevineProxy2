// probe-dumptoken.mjs — read the SW's pwAuthToken (token + capturedHeaders) and
// write them to %TEMP%/pw_probe.json for the datacenter test. Prints masked only.
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const PORT = process.env.CDP_PORT || 9222, HOST = '127.0.0.1';
async function httpJson(p){const r=await fetch(`http://${HOST}:${PORT}${p}`);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
const pending=new Map();
function send(ws,method,params={},sessionId){const id=send._id=(send._id||0)+1;const pl={id,method,params};if(sessionId)pl.sessionId=sessionId;return new Promise((res,rej)=>{pending.set(id,{res,rej});ws.send(JSON.stringify(pl));});}
const version=await httpJson('/json/version');
const ws=new WebSocket(version.webSocketDebuggerUrl,{perMessageDeflate:false,maxPayload:64*1024*1024});
await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
ws.on('message',(buf)=>{const m=JSON.parse(buf.toString());if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
let {targetInfos}=await send(ws,'Target.getTargets');
let sw=targetInfos.find(t=>t.type==='service_worker'&&/pkoikjpl/.test(t.url));
if(!sw){ try{await send(ws,'Target.createTarget',{url:'chrome-extension://pkoikjplcdkipeogmopelecfnfpaddcl/panel/panel.html'});}catch{} await new Promise(r=>setTimeout(r,1500)); ({targetInfos}=await send(ws,'Target.getTargets')); sw=targetInfos.find(t=>t.type==='service_worker'&&/pkoikjpl/.test(t.url)); }
if(!sw){ console.error('extension SW not found'); process.exit(2); }
const sid=await send(ws,'Target.attachToTarget',{targetId:sw.targetId,flatten:true});
const ssid = sid.sessionId;
await send(ws,'Runtime.enable',{},ssid);
const evalSW=async(expr)=>{const{result,exceptionDetails}=await send(ws,'Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true},ssid);if(exceptionDetails)throw new Error('eval err');return result.value;};
const a = await evalSW(`(async()=>{const s=await chrome.storage.local.get('pwAuthToken');return s.pwAuthToken||null;})()`);
let token = a && a.token, headers = (a && a.capturedHeaders) || {};
if(!token){ console.error('no token found'); process.exit(2); }
const outPath = join(tmpdir(), 'pw_probe.json');
writeFileSync(outPath, JSON.stringify({ token, headers }, null, 2));
console.log('wrote', outPath);
console.log('token len:', token.length, ' isJwt:', /^eyJ/.test(token), ' headerKeys:', Object.keys(headers));
ws.close(); process.exit(0);
