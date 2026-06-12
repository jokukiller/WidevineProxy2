// cdp-debug.mjs — minimal Chrome DevTools Protocol client to drive Opera GX
// (Chromium) for debugging the PW crawler extension from the shell.
//
// Prereq: launch Opera GX with a debugging port on your NORMAL profile so the
// extension + PW login persist. Fully quit Opera GX first, then:
//   & "C:\Users\anas\AppData\Local\Programs\Opera GX\opera.exe" --remote-debugging-port=9222
//
// Usage:
//   node cdp-debug.mjs targets
//   node cdp-debug.mjs storage                       # read pwAuthToken etc.
//   node cdp-debug.mjs eval <urlSubstr|type> "<js>"  # evaluate JS in a target
//   node cdp-debug.mjs watch <urlSubstr|type> <secs> # stream console output
//   node cdp-debug.mjs navigate <urlSubstr> <url>    # navigate a tab
//   node cdp-debug.mjs reload <urlSubstr>            # reload a tab
//   node cdp-debug.mjs diagnose [secs]               # full auth-capture probe

import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9222;
const HOST = '127.0.0.1';

async function httpJson(path) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

/** A connection to the browser-level CDP endpoint with flat session support. */
class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  static async connect() {
    let version;
    try {
      version = await httpJson('/json/version');
    } catch (e) {
      throw new Error(
        `Could not reach the DevTools endpoint on ${HOST}:${PORT}. ` +
        `Make sure Opera GX is fully quit and relaunched with --remote-debugging-port=${PORT}. (${e.message})`
      );
    }
    const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return new Browser(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  onEvent(fn) { this.listeners.push(fn); }

  async targets() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos;
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  close() { this.ws.close(); }
}

function matchTarget(targets, filter) {
  // filter can be a type ('page','service_worker','background_page','iframe') or a url/title substring
  const byType = targets.filter(t => t.type === filter);
  if (byType.length) return byType;
  const f = filter.toLowerCase();
  const subs = targets.filter(t =>
    (t.url || '').toLowerCase().includes(f) || (t.title || '').toLowerCase().includes(f));
  // Prefer real page targets over service workers / others that share the host.
  return subs.sort((a, b) => (b.type === 'page' ? 1 : 0) - (a.type === 'page' ? 1 : 0));
}

async function evalIn(browser, sessionId, expression) {
  await browser.send('Runtime.enable', {}, sessionId);
  const { result, exceptionDetails } = await browser.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
    userGesture: true,
  }, sessionId);
  if (exceptionDetails) {
    throw new Error('Eval exception: ' + (exceptionDetails.exception?.description || JSON.stringify(exceptionDetails)));
  }
  return result.value;
}

function printTargets(targets) {
  for (const t of targets) {
    console.log(`- [${t.type}] ${t.title || ''}\n    url: ${t.url}\n    id:  ${t.targetId}`);
  }
}

async function cmdTargets(browser) {
  printTargets(await browser.targets());
}

async function pickFirst(browser, filter) {
  const targets = await browser.targets();
  const matches = matchTarget(targets, filter);
  if (!matches.length) {
    console.error(`No target matches "${filter}". Available:`);
    printTargets(targets);
    process.exit(2);
  }
  return matches[0];
}

async function cmdEval(browser, filter, expr) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  const val = await evalIn(browser, sid, expr);
  console.log(`[${t.type}] ${t.url}`);
  console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
}

async function attachConsole(browser, sessionId, tag) {
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Log.enable', {}, sessionId).catch(() => {});
  browser.onEvent((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map(a => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ');
      console.log(`[${tag}:${msg.params.type}] ${args}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      console.log(`[${tag}:log:${e.level}] ${e.text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      console.log(`[${tag}:exception] ${msg.params.exceptionDetails?.exception?.description || ''}`);
    }
  });
}

async function cmdWatch(browser, filter, secs) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  console.log(`Watching [${t.type}] ${t.url} for ${secs}s ...`);
  await attachConsole(browser, sid, t.type);
  await new Promise(r => setTimeout(r, secs * 1000));
}

async function cmdNavigate(browser, filter, url) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  await browser.send('Page.enable', {}, sid).catch(() => {});
  await browser.send('Page.navigate', { url }, sid);
  console.log(`Navigated [${t.url}] -> ${url}`);
}

async function cmdReload(browser, filter) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  await browser.send('Page.enable', {}, sid).catch(() => {});
  await browser.send('Page.reload', { ignoreCache: true }, sid);
  console.log(`Reloaded ${t.url}`);
}

async function cmdStorage(browser, swFilter) {
  const targets = await browser.targets();
  const swMatches = matchTarget(targets, 'service_worker');
  const sw = (swFilter && swMatches.find(t => t.url.includes(swFilter)))
    || swMatches.find(t => /background\.js/.test(t.url))
    || swMatches[0]
    || matchTarget(targets, 'background_page')[0];
  if (!sw) {
    console.error('No extension service worker target found. Open the extension popup once to wake it, or check it is loaded.');
    printTargets(targets.filter(t => /chrome-extension/.test(t.url)));
    return;
  }
  const sid = await browser.attach(sw.targetId);
  const val = await evalIn(browser, sid, `(async () => {
    const s = await chrome.storage.local.get(['pwAuthToken','pwEndpointRegistry','pwCrawlHistory','pwCrawlSnapshot']);
    const t = s.pwAuthToken;
    return {
      tokenPresent: !!(t && t.token),
      tokenPreview: t && t.token ? t.token.slice(0,24)+'...' : null,
      capturedHeaderKeys: t && t.capturedHeaders ? Object.keys(t.capturedHeaders) : [],
      capturedAt: t ? t.capturedAt : null,
      historyCount: Array.isArray(s.pwCrawlHistory) ? s.pwCrawlHistory.length : 0,
    };
  })()`);
  console.log(`[service_worker] ${sw.url}`);
  console.log(JSON.stringify(val, null, 2));
}

async function cmdDiagnose(browser, secs, extId) {
  const targets = await browser.targets();
  console.log('=== Targets ===');
  printTargets(targets);

  // 1) Watch the PW page console + the extension SW console while reloading.
  const page = matchTarget(targets, 'pw.live')[0] || matchTarget(targets, 'page').find(t => /pw\.live|penpencil/.test(t.url));
  const swMatches = matchTarget(targets, 'service_worker');
  const sw = (extId && swMatches.find(t => t.url.includes(extId)))
    || swMatches.find(t => /background\.js/.test(t.url)) || swMatches[0];

  if (sw) {
    const swSid = await browser.attach(sw.targetId);
    await attachConsole(browser, swSid, 'SW');
  } else {
    console.log('(no service worker target — extension may be asleep or not loaded)');
  }

  if (!page) {
    console.log('\nNo pw.live tab open. Open https://www.pw.live/study-v2/pi in Opera GX, then re-run diagnose.');
  } else {
    const pSid = await browser.attach(page.targetId);
    await attachConsole(browser, pSid, 'PAGE');
    await browser.send('Page.enable', {}, pSid).catch(() => {});
    console.log(`\n=== Reloading ${page.url} and capturing console for ${secs}s ===`);
    await browser.send('Page.reload', { ignoreCache: true }, pSid);
    await new Promise(r => setTimeout(r, secs * 1000));
  }

  // 2) Read storage afterwards.
  console.log('\n=== Stored auth token ===');
  await cmdStorage(browser, extId);
}

async function cmdNetAuth(browser, filter, secs) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  await browser.send('Network.enable', {}, sid);
  await browser.send('Page.enable', {}, sid).catch(() => {});
  const reqs = new Map();
  browser.onEvent((msg) => {
    if (msg.sessionId !== sid) return;
    if (msg.method === 'Network.requestWillBeSent') {
      const { requestId, request } = msg.params;
      if (!/penpencil\.co/.test(request.url)) return;
      const auth = request.headers && (request.headers.Authorization || request.headers.authorization);
      reqs.set(requestId, { url: request.url, method: request.method, auth: auth || null });
    } else if (msg.method === 'Network.requestWillBeSentExtraInfo') {
      const r = reqs.get(msg.params.requestId);
      if (!r) return;
      const h = msg.params.headers || {};
      const auth = h.Authorization || h.authorization;
      if (auth) r.auth = auth;
    }
  });
  console.log(`Reloading ${t.url} and watching penpencil.co Authorization headers for ${secs}s (with scrolling) ...`);
  await browser.send('Page.reload', { ignoreCache: true }, sid);
  const steps = Math.max(1, Math.floor(secs / 1.5));
  for (let i = 0; i < steps; i++) {
    await new Promise(r => setTimeout(r, 1500));
    // Trigger lazy-loaded shelves/items by scrolling and nudging the carousels.
    await evalIn(browser, sid, `(()=>{ window.scrollBy(0, 1200); const els=document.querySelectorAll('[class*="scroll"],[class*="carousel"],[class*="slider"]'); els.forEach(e=>{ try{ e.scrollLeft += 1500; }catch{} }); return true; })()`).catch(() => {});
  }
  const rows = [...reqs.values()];
  for (const r of rows) {
    let host = '', path = ''; try { const u = new URL(r.url); host = u.host; path = u.pathname + u.search; } catch {}
    const isJwt = r.auth ? /^Bearer\s+eyJ/.test(r.auth) : false;
    const a = r.auth ? (r.auth.slice(0, 18) + '...') : '(none)';
    console.log(`${r.method.padEnd(4)} ${host}${path.slice(0, 160)}\n      auth=${a}  jwt=${isJwt}`);
  }
  const withJwt = rows.filter(r => r.auth && /^Bearer\s+eyJ/.test(r.auth));
  console.log(`\nTotal penpencil.co requests: ${rows.length} | carrying Bearer JWT: ${withJwt.length}`);
  if (withJwt.length) console.log(`Sample JWT host: ${new URL(withJwt[0].url).host}`);
}

async function cmdCrawl(browser, extId, depth = 'full', delayMs = 150) {
  if (!extId) { console.error('Usage: crawl <extId> [depth] [delayMs]'); return; }
  const { sid, targetId, created } = await getPanelSession(browser, extId);
  await new Promise(r => setTimeout(r, 300)); // let panel.js initialize

  const started = await evalIn(browser, sid,
    `(async()=>{ try { return await chrome.runtime.sendMessage({type:'CRAWL_START', depth:'${depth}', delayMs:${delayMs}}); } catch(e){ return {error:e.message}; } })()`);
  console.log('CRAWL_START ->', JSON.stringify(started));

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = await evalIn(browser, sid,
      `(async()=>{ return await chrome.runtime.sendMessage({type:'CRAWL_GET_STATE'}); })()`);
    const p = st && st.progress || {};
    console.log(`  [${st && st.state}] cats=${p.crawledCategories||0}/${p.totalCategories||0} widgets=${p.crawledWidgets||0}/${p.totalWidgets||0} playlists=${p.expandedPlaylists||0}/${p.totalPlaylists||0} lectures=${p.totalLectures||0} ${p.currentPath?('· '+p.currentPath):''}`);
    if (st && ['completed', 'error', 'stopped', 'idle'].includes(st.state) && i > 0) break;
  }

  const summary = await evalIn(browser, sid, `(async()=>{
    const r = await chrome.runtime.sendMessage({type:'CRAWL_GET_RESULTS'});
    if (!r) return { none:true };
    const lect = [];
    for (const c of r.categories||[]) for (const w of c.widgets||[]) for (const it of w.items||[]) {
      if (it.itemType==='playlist') for (const l of it.lectures||[]) lect.push(l);
      else if (it.itemType==='video') lect.push(it);
    }
    return {
      status: r.status,
      categories: (r.categories||[]).map(c=>({ id:c.categoryId, name:c.categoryName, widgets:(c.widgets||[]).length })),
      totalLectures: lect.length,
      errors: (r.errorsSample||[]),
      firstWatchUrls: lect.slice(0,5).map(l=>l.watchUrl),
    };
  })()`);
  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(summary, null, 2));
  if (created) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
}

async function findExtSw(browser, extId, { wake = true } = {}) {
  let targets = await browser.targets();
  let sw = matchTarget(targets, 'service_worker').find(t => t.url.includes(extId));
  if (sw || !wake) return sw;
  // SW is idle (MV3). Wake it by opening the popup page, then retry.
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/panel/panel.html` });
    await new Promise(r => setTimeout(r, 1200));
    targets = await browser.targets();
    sw = matchTarget(targets, 'service_worker').find(t => t.url.includes(extId));
    browser._wakePopupTargetId = targetId;
  } catch { /* ignore */ }
  return sw;
}

async function cmdApiGet(browser, extId, apiPath) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found (could not wake it)'); return; }
  const swSid = await browser.attach(sw.targetId);
  const auth = await evalIn(browser, swSid, `(async()=>{ const s=await chrome.storage.local.get('pwAuthToken'); return s.pwAuthToken||null; })()`);
  if (!auth || !auth.token) { console.error('no token in storage'); return; }

  const headersJson = JSON.stringify({ ...(auth.capturedHeaders || {}), Authorization: `Bearer ${auth.token}` });
  const full = apiPath.startsWith('http') ? apiPath : `https://api.penpencil.co/${apiPath.replace(/^\//, '')}`;
  const expr = `(async()=>{
    try {
      const r = await fetch(${JSON.stringify(full)}, { headers: ${headersJson} });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = null; }
      const shape = (v, d=0) => {
        if (d>3 || v===null) return typeof v;
        if (Array.isArray(v)) return '['+(v.length? shape(v[0],d+1):'')+'] x'+v.length;
        if (typeof v==='object') { const o={}; for (const k of Object.keys(v).slice(0,25)) o[k]=shape(v[k],d+1); return o; }
        return typeof v;
      };
      return { status:r.status, shape: j? shape(j):null, sample: t.slice(0,1800) };
    } catch(e){ return { error: e.message }; }
  })()`;
  // Run in the extension SW context (host permissions bypass page CORS/adblock).
  const res = await evalIn(browser, swSid, expr);
  console.log(`GET ${full}  (via service worker)`);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdDom(browser, filter) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  const expr = `(() => {
    const links = [...document.querySelectorAll('a[href*="/watch/"]')].map(a => a.getAttribute('href'));
    const bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500);
    const lower = bodyText.toLowerCase();
    return {
      url: location.href,
      watchLinks: links.length,
      sampleLinks: links.slice(0, 8),
      imgs: document.querySelectorAll('img').length,
      paywallHint: ['subscribe','unlock','buy now','locked','upgrade','plan'].filter(w => lower.includes(w)),
      bodyText,
    };
  })()`;
  const val = await evalIn(browser, sid, expr);
  console.log(`[${t.type}] ${t.url}`);
  console.log(JSON.stringify(val, null, 2));
}

async function cmdNetAll(browser, filter, secs) {
  const t = await pickFirst(browser, filter);
  const sid = await browser.attach(t.targetId);
  await browser.send('Network.enable', {}, sid);
  await browser.send('Page.enable', {}, sid).catch(() => {});
  const seen = new Map(); // host+path -> {method, count}
  const NOISE = /googletagmanager|google-analytics|doubleclick|facebook|clarity|moengage|mixpanel|sentry|cloudflareinsights|fonts\.|\.png|\.jpg|\.jpeg|\.webp|\.svg|\.css|\.woff|\.js($|\?)|analytics|metrics|gtm|firebase|unleash/i;
  browser.onEvent((msg) => {
    if (msg.sessionId !== sid) return;
    if (msg.method !== 'Network.requestWillBeSent') return;
    const { request, type } = msg.params;
    if (type !== 'XHR' && type !== 'Fetch') return;
    let key = request.url;
    try { const u = new URL(request.url); key = u.host + u.pathname; } catch {}
    if (NOISE.test(request.url)) return;
    if (request.method === 'OPTIONS') return;
    const e = seen.get(key) || { method: request.method, count: 0, sample: request.url };
    e.count++; seen.set(key, e);
  });
  console.log(`Reloading ${t.url}, listing XHR/Fetch endpoints for ${secs}s (scrolling)...`);
  await browser.send('Page.reload', { ignoreCache: true }, sid);
  const steps = Math.max(1, Math.floor(secs / 1.5));
  for (let i = 0; i < steps; i++) {
    await new Promise(r => setTimeout(r, 1500));
    await evalIn(browser, sid, `(()=>{window.scrollBy(0,1500);document.querySelectorAll('[class*="scroll"],[class*="carousel"],[class*="slider"],[class*="row"]').forEach(e=>{try{e.scrollLeft+=2000;}catch{}});return 1;})()`).catch(() => {});
  }
  const rows = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, e] of rows) console.log(`${e.method.padEnd(5)} ${key}  x${e.count}`);
  console.log(`\nUnique XHR/Fetch endpoints: ${rows.length}`);
}

async function cmdStatus(browser, extId) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found'); return; }
  const url = `chrome-extension://${extId}/panel/panel.html`;
  let pageT = (await browser.targets()).find(t => t.url === url);
  let targetId = pageT?.targetId;
  if (!targetId) ({ targetId } = await browser.send('Target.createTarget', { url }));
  const sid = await browser.attach(targetId);
  await browser.send('Runtime.enable', {}, sid);
  await new Promise(r => setTimeout(r, 600));
  const out = await evalIn(browser, sid, `(async()=>{
    const st = await chrome.runtime.sendMessage({type:'CRAWL_GET_STATE'});
    return { state: st && st.state, progress: st && st.progress };
  })()`);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdReloadExt(browser, extId) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found (could not wake it)'); return; }
  const sid = await browser.attach(sw.targetId);
  try { await evalIn(browser, sid, `chrome.runtime.reload()`); } catch { /* SW dies mid-eval; expected */ }
  console.log('extension reload issued');
}

async function cmdExtract(browser, extId, outBase) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found'); return; }
  const sid = await browser.attach(sw.targetId);
  const base = outBase || 'pi-catalog';

  // Compute a de-duplicated (by childId) flat catalog inside the SW from the
  // saved snapshot, stash it on globalThis for chunked retrieval (the full
  // result tree exceeds the 64MiB CDP message limit).
  const meta = await evalIn(browser, sid, `(async()=>{
    const s = await chrome.storage.local.get('pwCrawlSnapshot');
    const r = s.pwCrawlSnapshot && s.pwCrawlSnapshot.results;
    if (!r) return { error: 'no snapshot in storage' };
    const seen = new Set(); const flat = [];
    for (const c of (r.categories||[])) for (const w of (c.widgets||[])) for (const it of (w.items||[])) {
      const lecs = it.itemType==='playlist' ? (it.lectures||[]) : (it.itemType==='video' ? [it] : []);
      for (const l of lecs) {
        const id = l.childId; if (!id || seen.has(id)) continue; seen.add(id);
        flat.push({ childId: id, videoId: l.videoId||null, playlistId: l.playlistId||null, title: l.title||null, duration: l.duration||null, watchUrl: l.watchUrl });
      }
    }
    globalThis.__pwFlat = flat;
    return { unique: flat.length, status: s.pwCrawlSnapshot.results.status };
  })()`);
  if (!meta || meta.error) { console.error('extract failed:', meta && meta.error); return; }
  console.log(`Unique lectures: ${meta.unique} (crawl status: ${meta.status})`);

  const CHUNK = 2000;
  const all = [];
  for (let i = 0; i < meta.unique; i += CHUNK) {
    const part = await evalIn(browser, sid, `JSON.stringify(globalThis.__pwFlat.slice(${i}, ${i + CHUNK}))`);
    const arr = JSON.parse(part);
    all.push(...arr);
    process.stdout.write(`\r  fetched ${all.length}/${meta.unique}`);
  }
  process.stdout.write('\n');

  const fs = await import('node:fs/promises');
  await fs.writeFile(`${base}.json`, JSON.stringify(all, null, 2));
  await fs.writeFile(`${base}-urls.txt`, all.map(l => l.watchUrl).join('\n'));
  console.log(`Wrote ${base}.json and ${base}-urls.txt (${all.length} unique lectures)`);
}

async function cmdDupCheck(browser, extId) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found'); return; }
  const sid = await browser.attach(sw.targetId);
  const out = await evalIn(browser, sid, `(async()=>{
    const s = await chrome.storage.local.get('pwCrawlSnapshot');
    const r = s.pwCrawlSnapshot && s.pwCrawlSnapshot.results;
    if (!r) return { error: 'no snapshot' };
    let occ = 0;
    const idToTitles = new Map();   // childId -> Set(title)
    const titleToIds = new Map();   // title  -> Set(childId)
    const idToPlaylists = new Map();// childId -> Set(playlistId)
    for (const c of (r.categories||[])) for (const w of (c.widgets||[])) for (const it of (w.items||[])) {
      const lecs = it.itemType==='playlist' ? (it.lectures||[]) : (it.itemType==='video' ? [it] : []);
      for (const l of lecs) {
        const id = l.childId; if (!id) continue; occ++;
        const t = (l.title||'').trim();
        if (!idToTitles.has(id)) idToTitles.set(id, new Set()); idToTitles.get(id).add(t);
        if (!titleToIds.has(t)) titleToIds.set(t, new Set()); titleToIds.get(t).add(id);
        if (!idToPlaylists.has(id)) idToPlaylists.set(id, new Set()); if (l.playlistId) idToPlaylists.get(id).add(l.playlistId);
      }
    }
    let idsWithMultiTitle = 0, multiTitleSamples = [];
    for (const [id, set] of idToTitles) if (set.size > 1) { idsWithMultiTitle++; if (multiTitleSamples.length<3) multiTitleSamples.push({ id, titles:[...set] }); }
    let titlesSharedAcrossIds = 0, sharedTitleSamples = [];
    for (const [t, set] of titleToIds) if (set.size > 1) { titlesSharedAcrossIds++; if (sharedTitleSamples.length<5) sharedTitleSamples.push({ title:t, distinctChildIds:set.size }); }
    let idsInMultiPlaylists = 0;
    for (const [, set] of idToPlaylists) if (set.size > 1) idsInMultiPlaylists++;
    return {
      occurrences: occ,
      uniqueChildIds: idToTitles.size,
      idsWithMultipleTitles: idsWithMultiTitle,
      multiTitleSamples,
      distinctTitles: titleToIds.size,
      titlesSharedAcrossDifferentChildIds: titlesSharedAcrossIds,
      sharedTitleSamples,
      childIdsAppearingInMultiplePlaylists: idsInMultiPlaylists,
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdWidgetStats(browser, extId) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found'); return; }
  const sid = await browser.attach(sw.targetId);
  const out = await evalIn(browser, sid, `(async()=>{
    const s = await chrome.storage.local.get('pwCrawlSnapshot');
    const r = s.pwCrawlSnapshot && s.pwCrawlSnapshot.results;
    if (!r) return { error: 'no snapshot' };
    const byType = new Map(); // widgetType -> { widgets, items, playlists, videos, sampleTitles:Set }
    let widgetsWithPlaylists = 0, widgetsItemsOnly = 0;
    for (const c of (r.categories||[])) for (const w of (c.widgets||[])) {
      const t = w.widgetType || '(none)';
      const e = byType.get(t) || { widgets:0, items:0, playlists:0, videos:0, sampleTitles:new Set() };
      e.widgets++;
      let hasPlaylist=false;
      for (const it of (w.items||[])) {
        e.items++;
        if (it.itemType==='playlist'){ e.playlists++; hasPlaylist=true; }
        else if (it.itemType==='video'){ e.videos++; }
      }
      if (e.sampleTitles.size < 6 && w.widgetName) e.sampleTitles.add(w.widgetName);
      if (hasPlaylist) widgetsWithPlaylists++; else widgetsItemsOnly++;
      byType.set(t, e);
    }
    const types = [...byType.entries()].map(([type,e])=>({ type, widgets:e.widgets, items:e.items, playlists:e.playlists, videos:e.videos, sampleTitles:[...e.sampleTitles] }))
      .sort((a,b)=>b.items-a.items);
    return { types, widgetsWithPlaylists, widgetsItemsOnly };
  })()`);
  console.log(JSON.stringify(out, null, 2));
}

async function cmdNormalize(browser, extId, outBase) {
  const sw = await findExtSw(browser, extId);
  if (!sw) { console.error('extension SW not found'); return; }
  const sid = await browser.attach(sw.targetId);
  const base = outBase || 'pi';

  // Step 1: build categoryId -> {name,parentId,isRoot} by walking the tree.
  const catMeta = await evalIn(browser, sid, `(async()=>{
    const auth = (await chrome.storage.local.get('pwAuthToken')).pwAuthToken;
    if (!auth || !auth.token) return { error: 'no token' };
    const headers = { ...(auth.capturedHeaders||{}), Authorization: 'Bearer '+auth.token, Accept: 'application/json' };
    const get = async (u) => { const r = await fetch(u, { headers }); if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); };
    const B = 'https://api.penpencil.co/ott/v1/ott/category';
    const map = {}; const visited = new Set();
    const roots = (await get(B)).data || [];
    const q = [...roots];
    while (q.length) {
      const c = q.shift(); const id = c && c._id; if (!id) continue;
      map[id] = { name: c.name||null, parentId: c.parentId||null, isRoot: !!c.isRoot };
      if ((c.childCount||0) > 0 && !visited.has(id)) {
        visited.add(id);
        try { for (const x of ((await get(B+'?parentId='+id)).data || [])) { if (x && x._id) { map[x._id] = { name:x.name||null, parentId:x.parentId||null, isRoot:!!x.isRoot }; q.push(x); } } } catch {}
      }
    }
    globalThis.__catMap = map;
    return { categories: Object.keys(map).length };
  })()`);
  if (!catMeta || catMeta.error) { console.error('category tree fetch failed:', catMeta && catMeta.error); return; }
  console.log(`Category tree: ${catMeta.categories} categories mapped`);

  // Step 2: transform the snapshot into assets / placements / discovery-orphans.
  const meta = await evalIn(browser, sid, `(async()=>{
    const s = await chrome.storage.local.get('pwCrawlSnapshot');
    const r = s.pwCrawlSnapshot && s.pwCrawlSnapshot.results;
    if (!r) return { error: 'no snapshot' };
    const catMap = globalThis.__catMap || {};
    const CURRICULUM = new Set(['Generic Widget']);
    const mainBranchOf = (id) => { let g=0; while (id && catMap[id] && !catMap[id].isRoot && catMap[id].parentId && g++<20) id = catMap[id].parentId; return id; };
    const assets = new Map(); const placements = []; const pseen = new Set(); const discovery = new Map();
    for (const c of (r.categories||[])) {
      const subId = c.categoryId;
      const subName = c.categoryName || (catMap[subId] && catMap[subId].name) || null;
      const mbId = mainBranchOf(subId);
      const mbName = (catMap[mbId] && catMap[mbId].name) || null;
      for (const w of (c.widgets||[])) {
        const curric = CURRICULUM.has(w.widgetType);
        for (const it of (w.items||[])) {
          const isPl = it.itemType === 'playlist';
          const lecs = isPl ? (it.lectures||[]) : (it.itemType==='video' ? [it] : []);
          for (const l of lecs) {
            if (!l.childId) continue;
            let a = assets.get(l.childId);
            if (!a) { a = { childId: l.childId, videoId: l.videoId||null, title: l.title||null, duration: l.duration||null, curriculumPlacements: 0 }; assets.set(l.childId, a); }
            if (curric) {
              const key = subId+'|'+w.widgetId+'|'+(isPl?it.playlistId:'')+'|'+l.childId;
              if (pseen.has(key)) continue; pseen.add(key);
              a.curriculumPlacements++;
              placements.push({
                childId: l.childId,
                mainBranchId: mbId, mainBranch: mbName,
                subBranchId: subId, subBranch: subName,
                subjectId: w.widgetId, subject: w.widgetName||null,
                classId: isPl ? it.playlistId : null, class: isPl ? (it.title||null) : null,
                lecture: l.title||null,
                watchUrl: l.watchUrl,
              });
            } else {
              let d = discovery.get(l.childId);
              if (!d) { d = { childId: l.childId, title: l.title||null, seenIn: [] }; discovery.set(l.childId, d); }
              if (d.seenIn.length < 10) d.seenIn.push({ widgetType: w.widgetType, widget: w.widgetName||null, subBranchId: subId });
            }
          }
        }
      }
    }
    const orphans = [];
    for (const [id, a] of assets) if (a.curriculumPlacements === 0) { const d = discovery.get(id); orphans.push({ childId: id, title: a.title, seenIn: d ? d.seenIn : [] }); }
    globalThis.__assets = [...assets.values()];
    globalThis.__placements = placements;
    globalThis.__orphans = orphans;
    return { assets: assets.size, curriculumPlacements: placements.length, orphans: orphans.length, promotionalChildIds: discovery.size };
  })()`);
  if (!meta || meta.error) { console.error('transform failed:', meta && meta.error); return; }
  console.log(`assets=${meta.assets} curriculumPlacements=${meta.curriculumPlacements} orphans=${meta.orphans} (childIds seen in promo widgets=${meta.promotionalChildIds})`);

  const fs = await import('node:fs/promises');
  const dump = async (globalName, count, file) => {
    const all = [];
    for (let i = 0; i < count; i += 2000) {
      const part = await evalIn(browser, sid, `JSON.stringify(globalThis.${globalName}.slice(${i}, ${i + 2000}))`);
      all.push(...JSON.parse(part));
      process.stdout.write(`\r  ${file}: ${all.length}/${count}`);
    }
    process.stdout.write('\n');
    await fs.writeFile(file, JSON.stringify(all, null, 2));
  };
  await dump('__assets', meta.assets, `${base}-assets.json`);
  await dump('__placements', meta.curriculumPlacements, `${base}-placements.json`);
  await dump('__orphans', meta.orphans, `${base}-discovery-orphans.json`);
  console.log(`Wrote ${base}-assets.json, ${base}-placements.json, ${base}-discovery-orphans.json`);
}

async function getPanelSession(browser, extId) {
  const url = `chrome-extension://${extId}/panel/panel.html`;
  const targets = await browser.targets();
  const existing = targets.find(x => x.url === url);
  if (existing) {
    const sid = await browser.attach(existing.targetId);
    await browser.send('Runtime.enable', {}, sid);
    return { sid, targetId: existing.targetId, created: false };
  }
  try {
    const { targetId } = await browser.send('Target.createTarget', { url });
    const sid = await browser.attach(targetId);
    await browser.send('Runtime.enable', {}, sid);
    await new Promise(r => setTimeout(r, 600));
    return { sid, targetId, created: true };
  } catch (e) {
    // Opera sometimes refuses new tabs; reuse a throwaway page instead.
    const page = targets.find(x => x.type === 'page' && /startpage|speeddial|about:blank|newtab/i.test(x.url));
    if (!page) throw new Error('cannot open panel (' + e.message + ')');
    const sid = await browser.attach(page.targetId);
    await browser.send('Page.enable', {}, sid).catch(() => {});
    await browser.send('Page.navigate', { url }, sid);
    await new Promise(r => setTimeout(r, 1400));
    await browser.send('Runtime.enable', {}, sid);
    return { sid, targetId: page.targetId, created: false };
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const browser = await Browser.connect();
  try {
    switch (cmd) {
      case 'targets': await cmdTargets(browser); break;
      case 'storage': await cmdStorage(browser, a); break;
      case 'eval': await cmdEval(browser, a, b); break;
      case 'watch': await cmdWatch(browser, a, Number(b || 15)); break;
      case 'navigate': await cmdNavigate(browser, a, b); break;
      case 'reload': await cmdReload(browser, a); break;
      case 'diagnose': await cmdDiagnose(browser, Number(a || 12), b); break;
      case 'netauth': await cmdNetAuth(browser, a || 'pw.live', Number(b || 14)); break;
      case 'crawl': await cmdCrawl(browser, a, b || 'full', Number(process.argv[5] || 150)); break;
      case 'apiget': await cmdApiGet(browser, a, b); break;
      case 'dom': await cmdDom(browser, a || 'pw.live'); break;
      case 'netall': await cmdNetAll(browser, a || 'pw.live', Number(b || 16)); break;
      case 'status': await cmdStatus(browser, a); break;
      case 'reloadext': await cmdReloadExt(browser, a); break;
      case 'extract': await cmdExtract(browser, a, b); break;
      case 'dupcheck': await cmdDupCheck(browser, a); break;
      case 'widgetstats': await cmdWidgetStats(browser, a); break;
      case 'normalize': await cmdNormalize(browser, a, b); break;
      default:
        console.log('Commands: targets | storage | eval <f> <js> | watch <f> <secs> | navigate <f> <url> | reload <f> | diagnose [secs]');
    }
  } finally {
    browser.close();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
