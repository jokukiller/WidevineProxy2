// probe-localhttp.mjs — prove video-url-details works from plain Node (no browser,
// no cookies; just captured headers + bearer). Reads %TEMP%/pw_probe.json.
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { token, headers } = JSON.parse(readFileSync(join(tmpdir(), 'pw_probe.json'), 'utf8'));
const childId = '699fe7fb0e6503b008feaffb';
const h = { ...headers, Authorization: 'Bearer ' + token };
delete h['content-type']; // GET
const u = `https://api.penpencil.co/v1/videos/video-url-details?type=OTT&videoContainerType=DASH&reqType=query&childId=${childId}&clientVersion=201`;
const r = await fetch(u, { headers: h });
const t = await r.text();
let j; try { j = JSON.parse(t); } catch {}
console.log('status:', r.status);
console.log('success:', j && j.success);
console.log('has manifest url:', !!(j && j.data && j.data.url));
console.log('videoId:', j && j.data && j.data.videoId);
console.log('sent header keys:', Object.keys(h));
if (!j || !j.data) console.log('body:', t.slice(0, 300));
