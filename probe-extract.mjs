import { readFileSync } from 'node:fs';

const bundle = process.argv[2];
const needle = process.argv[3] || 'video-url-details';
const span = Number(process.argv[4] || 500);

const src = readFileSync(bundle, 'utf8');
let idx = 0;
let n = 0;
const seen = new Set();
while ((idx = src.indexOf(needle, idx)) !== -1 && n < 12) {
  const start = Math.max(0, idx - span);
  const end = Math.min(src.length, idx + needle.length + span);
  const chunk = src.slice(start, end);
  // de-dup near-identical neighborhoods
  const sig = chunk.slice(0, 80);
  if (!seen.has(sig)) {
    seen.add(sig);
    console.log('==== match', ++n, 'at', idx, '====');
    console.log(chunk);
    console.log('');
  }
  idx += needle.length;
}
console.log('total scanned, printed', n);
