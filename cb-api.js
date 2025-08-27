// cb-api.js — centralized API module (no UI). All API, auth, logging, and payload shaping lives here.

// ---------- Config & persistence ----------
const storeKey = 'cb_api';
function getConfig(){
  try{ return JSON.parse(localStorage.getItem(storeKey) || 'null'); }catch{ return null; }
}
function setConfig(cfg){
  const prev = getConfig() || {};
  const next = { url: '', key: '', mode:'xapikey', param:'apiKey', ...prev, ...cfg };
  localStorage.setItem(storeKey, JSON.stringify(next));
  return next;
}

// ---------- Logging ----------
const LOG_CAP = 5000;
const logs = [];
let logSubscribers = [];
function pushLog(entry){
  const item = { t: new Date().toISOString(), ...entry };
  logs.push(item); if(logs.length > LOG_CAP) logs.shift();
  logSubscribers.forEach(fn => { try{ fn(item); }catch{} });
  // Console mirror (level-aware)
  const fn = item.level==='error'?'error':(item.level==='warn'?'warn':'log');
  console[fn](item);
}
function getLogs(){ return logs.slice(); }
function clearLogs(){ logs.length = 0; }
function onLog(cb){ logSubscribers.push(cb); return ()=>{ logSubscribers = logSubscribers.filter(f=>f!==cb); }; }
function log(msg, level='info', extra=''){ pushLog({msg, level, extra}); }

// ---------- Utilities ----------
function joinUrl(base, path){ return base.replace(/\/+$/,'') + (path.startsWith('/')? path : '/'+path); }
function addQuery(url, kv){ const u = new URL(url); for(const [k,v] of Object.entries(kv)) if (v!=null && v!=='') u.searchParams.set(k, v); return u.toString(); }
function objFromHeaders(headers){ const o={}; try{ for(const [k,v] of headers.entries()) o[k]=v; }catch{} return o; }
function redactHeaders(headers){
  const safe = {...headers};
  if('X-API-Key' in safe) safe['X-API-Key'] = '***';
  if('Authorization' in safe) safe['Authorization'] = '***';
  return safe;
}
function redactUrlParam(url, paramName){
  try{ const u = new URL(url); if (u.searchParams.has(paramName)) u.searchParams.set(paramName, '***'); return u.toString(); }
  catch{ return url; }
}
function todayISO(){ const d=new Date(); return d.toISOString().slice(0,10); }

// ---------- Auth helpers ----------
function buildAuthHeaders(mode, key){ const h={}; if(mode==='bearer') h['Authorization']=`Bearer ${key}`; else if(mode==='xapikey') h['X-API-Key']=key; return h; }
function applyAuthToUrl(url, mode, key, paramName){ return mode==='query' ? addQuery(url, {[paramName]: key}) : url; }

// ---------- Network layer ----------
function netStart({method, url, headers, paramName}){
  const id = Math.random().toString(36).slice(2,9);
  const start = performance.now();
  const urlRed = redactUrlParam(url, paramName);
  pushLog({ level:'info', msg:`HTTP ${method} ${urlRed}`, extra:'→ request', id, method, url:urlRed, start, reqHeaders:redactHeaders(headers) });
  return { id, start, method, url, paramName };
}
function netEnd(ctx, res, bodySample){
  const dur = (performance.now()-ctx.start).toFixed(0);
  const h = objFromHeaders(res.headers||{});
  pushLog({ level:'info', msg:`HTTP ${ctx.method} ${redactUrlParam(ctx.url, ctx.paramName)}`, extra:`← ${res.status} ${res.statusText} (${dur}ms)`, id:ctx.id, dur, status:res.status, resHeaders:h, body: bodySample });
}
function netErr(ctx, err){
  const dur = (performance.now()-ctx.start).toFixed(0);
  pushLog({ level:'error', msg:`HTTP ${ctx.method} ${redactUrlParam(ctx.url, ctx.paramName)}`, extra:`✖ ${err.message} (${dur}ms)`, id:ctx.id, dur, error:String(err) });
  if (String(err).includes('Failed to fetch')) log('Hint: CORS preflight blocked by browser. Confirm server CORS & allowed headers.', 'warn');
}

async function apiFetch(path, opts={}){
  const cfg = getConfig(); if(!cfg?.url) throw new Error('Missing API base URL. Open API Settings.');
  const method = (opts.method || 'GET').toUpperCase();
  const mode = cfg.mode || 'xapikey'; const key = cfg.key || ''; const paramName = cfg.param || 'apiKey';
  const baseUrl = joinUrl(cfg.url, path); const url = applyAuthToUrl(baseUrl, mode, key, paramName);
  const headers = { ...(opts.headers||{}), ...buildAuthHeaders(mode, key) };
  if (opts.body && typeof opts.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const ctx = netStart({ method, url, headers, paramName });
  try{
    const res = await fetch(url, { method, headers, body: opts.body || undefined, mode:'cors', credentials:'omit' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    let bodySample = null;
    try{
      if (ct.includes('application/json')) bodySample = JSON.stringify(await res.clone().json()).slice(0,2000);
      else if (ct.includes('text/')) bodySample = (await res.clone().text()).slice(0,2000);
      else { const blob = await res.clone().blob(); bodySample = `[blob ${blob.type||'application/octet-stream'} ${blob.size} bytes]`; }
    }catch{}

    netEnd(ctx, res, bodySample);
    if(!res.ok){ const err = new Error(`HTTP ${res.status} ${res.statusText}${bodySample ? ' — ' + bodySample : ''}`); err.status=res.status; err.body = bodySample||''; throw err; }
    if(ct.includes('application/json')) return res.json();
    return res.blob();
  }catch(e){
    // Multipart -> JSON fallback for media-type errors
    const isUnsupported = e?.status === 415 || (e?.status === 500 && String(e.body||'').includes("Unsupported Media Type"));
    if (isUnsupported && opts.body instanceof FormData && path.includes('/sessions/upload')) {
      try {
        const asJson = await formDataToJsonPayload(opts.body);
        if ('notes' in asJson) delete asJson.notes; // final safety
        log('Server rejected multipart for /sessions/upload. Retrying with JSON payload (base64 + timing)…','warn');
        return await apiFetch(path, { ...opts, body: JSON.stringify(asJson) });
      } catch(re){ log('Retry-as-JSON failed to construct payload: ' + re.message, 'error'); }
    }
    netErr(ctx, e); throw e;
  }
}

// ---------- JSON fallback helpers ----------
function readBlobAsDataURL(blob){
  return new Promise((resolve,reject)=>{ const r=new FileReader(); r.onerror=()=>reject(new Error('FileReader error')); r.onload=()=>resolve(String(r.result||'')); r.readAsDataURL(blob); });
}
async function formDataToJsonPayload(fd){
  const payload = { images: [], audio: null };
  const plain = {};
  for (const [k, v] of fd.entries()){
    if (v instanceof Blob){
      const isAudio = k.toLowerCase().includes('audio');
      const dataUrl = await readBlobAsDataURL(v);
      const [meta, b64] = dataUrl.split(',', 2);
      const contentType = (meta.match(/^data:(.*?);base64$/)||[])[1] || (v.type||'application/octet-stream');
      const fileObj = { filename: (v.name||('file.'+(contentType.split('/')[1]||'bin'))), content_type: contentType, data: b64 };
      if (isAudio) payload.audio = fileObj; else payload.images.push(fileObj);
    } else {
      plain[k] = v;
    }
  }

  // 🚫 never allow a `notes` key to survive
  if ('notes' in plain) delete plain.notes;

  // explicit mapping
  const conference_id = plain.conference_id || plain.conferenceId || '';
  const vendor_id     = plain.vendor_id || plain.vendorId || '';
  const text          = plain.text || ''; // already mapped
  const start_time    = plain.start_time || plain.startTime || '';
  const end_time      = plain.end_time || plain.endTime || '';
  const duration      = plain.duration_seconds || plain.durationSeconds || '';

  if (conference_id){ payload.conference_id = conference_id; payload.conferenceId = conference_id; }
  if (vendor_id){     payload.vendor_id     = vendor_id;     payload.vendorId     = vendor_id; }
  if (text){          payload.text          = text; }
  if (start_time){    payload.start_time    = start_time;    payload.startTime    = start_time; }
  if (end_time){      payload.end_time      = end_time;      payload.endTime      = end_time; }
  if (duration){      payload.duration_seconds = duration;   payload.durationSeconds = duration; }

  if ('notes' in payload) delete payload.notes; // belt & braces
  return payload;
}

// ---------- High-level API ----------
async function listConferences(){
  const r = await apiFetch('/conferences');
  return Array.isArray(r) ? r : (r?.data || []);
}
async function createConference(payload/* {name, start_date, end_date} */){
  return apiFetch('/conferences', { method:'POST', body: JSON.stringify(payload) });
}
async function listVendorsForConference(confId){
  const r = await apiFetch(`/conferences/${encodeURIComponent(confId)}/vendors`);
  return Array.isArray(r) ? r : (r?.data || []);
}
async function listAllVendors(){
  const r = await apiFetch('/vendors');
  return Array.isArray(r) ? r : (r?.data || []);
}
async function createVendor(payload/* {name, conference_id} */){
  return apiFetch('/vendors', { method:'POST', body: JSON.stringify(payload) });
}
async function getVendor(vendorId){
  return apiFetch(`/vendors/${encodeURIComponent(vendorId)}`);
}

async function ensureUnknownConference(){
  try{
    const list = await listConferences();
    const unk = (list||[]).find(c => (c.name||'').toLowerCase()==='unknown conference');
    if (unk) return (unk.id ?? unk._id ?? unk.uuid ?? unk.conferenceId);
  }catch(e){ log('Could not list conferences while searching for Unknown Conference: '+e.message,'warn'); }
  const created = await createConference({ name:'Unknown Conference', start_date: todayISO(), end_date: todayISO() });
  const cid = created?.id ?? created?._id ?? created?.uuid ?? created?.conferenceId;
  log(`Created Unknown Conference: ${cid}`);
  return cid;
}

async function getOrCreateVendorByName(conferenceId, name){
  try{
    const list = await listVendorsForConference(conferenceId);
    const found = (list||[]).find(v => (v.name||'').toLowerCase() === (name||'').toLowerCase());
    if(found) return (found.id ?? found._id ?? found.uuid ?? found.vendorId);
  }catch(e){ log(`Could not list vendors for conference ${conferenceId}: `+e.message,'warn'); }
  const created = await createVendor({ name, conference_id: conferenceId });
  const vid = created?.id ?? created?._id ?? created?.uuid ?? created?.vendorId;
  log(`Created Vendor "${name}" for conference ${conferenceId}: ${vid}`);
  return vid;
}

async function ensureConferenceVendor({ conferenceId, vendorId, preferredVendorName }){
  if(!conferenceId){
    conferenceId = await ensureUnknownConference();
  }
  if(vendorId){
    try{
      const v = await getVendor(vendorId);
      const vcid = v?.conference_id ?? v?.conferenceId ?? v?.data?.conference_id ?? null;
      if (vcid && conferenceId && String(vcid) !== String(conferenceId)) {
        log(`Vendor ${vendorId} belongs to a different conference (${vcid} != ${conferenceId}). Creating scoped vendor.`, 'warn');
        vendorId = await getOrCreateVendorByName(conferenceId, preferredVendorName || 'Unknown Vendor');
      }
    }catch(e){
      log(`Provided vendor ID ${vendorId} not found. Creating vendor instead.`, 'warn');
      vendorId = await getOrCreateVendorByName(conferenceId, preferredVendorName || 'Unknown Vendor');
    }
  } else {
    vendorId = await getOrCreateVendorByName(conferenceId, preferredVendorName || 'Unknown Vendor');
  }
  return { conferenceId, vendorId };
}

// Upload session: handles multipart and JSON fallback; never sends `notes`.
async function uploadSession({ audioBlob, images, text, conferenceId, vendorId, startIso, endIso }){
  const duration = secondsBetweenISO(startIso, endIso);

  const fd = new FormData();
  if(audioBlob) fd.append('audio', audioBlob, `session.${(audioBlob.type.split('/')[1]||'webm').split(';')[0]}`);
  for(const f of images || []){ fd.append('images', f, f.name); }
  if(text) fd.append('text', text); // correct key

  // IDs and timing (include both snake & camel for safety)
  fd.append('conference_id', conferenceId); fd.append('conferenceId', conferenceId);
  fd.append('vendor_id', vendorId);         fd.append('vendorId', vendorId);
  fd.append('start_time', startIso);        fd.append('startTime', startIso);
  fd.append('end_time', endIso);            fd.append('endTime', endIso);
  fd.append('duration_seconds', String(duration)); fd.append('durationSeconds', String(duration));

  // Try multipart first, fallback handled in apiFetch
  const res = await apiFetch('/sessions/upload', { method:'POST', body: fd });
  const sessionId = res.id ?? res.sessionId ?? res._id ?? res.uuid;
  if(!sessionId) throw new Error('Upload succeeded but response did not include a session ID.');

  // Trigger enrichment (non-fatal if it fails)
  try{ await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/enrich`, { method:'POST' }); log('Enrichment triggered.'); }
  catch(e){ log(`Warning: could not trigger enrichment automatically — ${e.message}`,'warn'); }

  return sessionId;
}

function secondsBetweenISO(a,b){ try{ return Math.max(0, Math.round((new Date(b).getTime()-new Date(a).getTime())/1000)); }catch{ return 0; } }

async function listSessionsForVendor(vendorId){
  return apiFetch(`/vendors/${encodeURIComponent(vendorId)}/sessions`);
}
async function getSession(sessionId){
  return apiFetch(`/sessions/${encodeURIComponent(sessionId)}`);
}
async function getSessionReport(sessionId){
  return apiFetch(`/reports/session/${encodeURIComponent(sessionId)}`);
}

// ---------- Self-test ----------
async function testConnectivity(){
  const cfg = getConfig();
  const optionsUrl = joinUrl(cfg.url, '/conferences');
  const ctx = netStart({method:'OPTIONS', url:optionsUrl, headers:{}, paramName:cfg.param||'apiKey'});
  const res = await fetch(optionsUrl, { method:'OPTIONS', mode:'cors', credentials:'omit' });
  const h = objFromHeaders(res.headers); netEnd(ctx, res, JSON.stringify(h).slice(0,1000));
  await apiFetch('/health');
  await apiFetch('/conferences');
}

function mkSilentWav(seconds=1, sampleRate=8000){
  const numSamples = seconds * sampleRate, bytesPerSample=2, blockAlign=1*bytesPerSample, byteRate=sampleRate*blockAlign, dataSize=numSamples*bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize); const dv = new DataView(buf); let o=0;
  function w32(v){ dv.setUint32(o, v, true); o+=4; } function w16(v){ dv.setUint16(o, v, true); o+=2; } function ws(s){ for(let i=0;i<s.length;i++) dv.setUint8(o++, s.charCodeAt(i)); }
  ws('RIFF'); w32(36 + dataSize); ws('WAVE'); ws('fmt '); w32(16); w16(1); w16(1); w32(sampleRate); w32(byteRate); w16(blockAlign); w16(16); ws('data'); w32(dataSize);
  return new Blob([buf], { type:'audio/wav' });
}

async function runSelfTest(){
  const out = [];
  try{
    const cfg = getConfig(); if(!cfg?.url || !cfg?.key){ out.push('✖ Missing URL or API key in settings.'); return out; }
    out.push('• Using base: ' + cfg.url);

    await testConnectivity();
    out.push('GET /health ✓');

    const confs = await listConferences(); out.push(`GET /conferences ✓ (${confs.length} found)`);

    const cname = 'CB SelfTest ' + new Date().toISOString(); const today = todayISO();
    const cRes = await createConference({ name:cname, start_date: today, end_date: today });
    const cid = cRes.id ?? cRes._id ?? cRes.uuid ?? cRes.conferenceId; out.push(`POST /conferences ✓ id=${cid}`);

    const vRes = await createVendor({ name:'CB SelfTest Vendor', conference_id: cid });
    const vid = vRes.id ?? vRes._id ?? vRes.uuid ?? vRes.vendorId; out.push(`POST /vendors ✓ id=${vid}`);

    const st = new Date().toISOString();
    const silent = mkSilentWav(1,8000);
    const sessionId = await uploadSession({
      audioBlob: silent,
      images: [],
      text: 'Self-test upload ' + st,
      conferenceId: cid,
      vendorId: vid,
      startIso: st,
      endIso: st
    });
    out.push(`POST /sessions/upload ✓ id=${sessionId}`);

    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}`); out.push('GET /sessions/{id} ✓');
    await apiFetch(`/reports/session/${encodeURIComponent(sessionId)}`); out.push('GET /reports/session/{id} ✓');

    out.push('✔ Self-Test completed. See Logs (Verbose) for details.');
  }catch(e){
    out.push('✖ Self-Test failed: ' + e.message + ' — check Logs for details.');
  }
  return out;
}

// ---------- API export surface ----------
export {
  // config & utils
  setConfig, getConfig, todayISO,
  // logging
  onLog, getLogs, clearLogs, log,
  // generic
  apiFetch, testConnectivity,
  // domain helpers
  listConferences, createConference,
  listVendorsForConference, listAllVendors, createVendor, getVendor,
  ensureConferenceVendor,
  uploadSession, listSessionsForVendor, getSession, getSessionReport,
  runSelfTest,
  // namespace-like export for quick use
  // (exposes log/testConnectivity for UI convenience)
  // eslint-disable-next-line no-object-literal-type-assertion
  api as default
};

// Simple namespace-like object for convenience imports in index.html
const api = {
  log, testConnectivity
};
