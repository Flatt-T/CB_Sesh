// cb-api.js — All API I/O + structured logging
// Uses the API KB guidance:
// - POST /api/sessions/upload accepts JSON (user_notes) or multipart; we use JSON first
// - Then POST /api/sessions/:id/add-files with multipart (audio_files[], image_files[], notes?) for actual files
// - Vendors/Conferences endpoints require JSON and X-API-Key
// Ref KB: Session upload & add-files details.

/* =========================== Logger =========================== */
const __logs = [];
function _stamp(){ return new Date().toISOString(); }
function log(level, msg, extra){
  const entry = { t: _stamp(), level: (level||'info'), msg: String(msg), extra: extra ?? '' };
  __logs.push(entry);
  // console side too, for dev
  const fn = (level==='error'?'error':(level==='warn'?'warn':'log'));
  console[fn](`[${entry.t}] ${entry.level.toUpperCase()} ${entry.msg} ${entry.extra?'- '+entry.extra:''}`);
}
function logsToJson(){ return [...__logs]; }
function logsToText(){
  return __logs.map(l=>`${l.t} [${l.level.toUpperCase()}] ${l.msg}${l.extra?` ${l.extra}`:''}`).join('\n');
}
function clearLogs(){ __logs.length = 0; }

/* =========================== Config =========================== */
const LS_KEY = 'cb_cfg_v2';
let CFG = { base:'', key:'' };
function setConfig({ base, key }){
  if(typeof base==='string') CFG.base = base.replace(/\/+$/,''); // drop trailing slash
  if(typeof key==='string') CFG.key = key;
  localStorage.setItem(LS_KEY, JSON.stringify(CFG));
  log('info','Config updated.');
}
function getConfig(){
  const s = localStorage.getItem(LS_KEY);
  if(s){ try{ CFG = JSON.parse(s) || CFG; }catch{} }
  return { ...CFG };
}
function assertConfig(){
  const c = getConfig();
  if(!c.base){ throw new Error('API base URL not configured.'); }
  if(!c.key){ throw new Error('API key not configured.'); }
  return c;
}

/* =========================== Helpers =========================== */
const nowIso = ()=> new Date().toISOString();
const ymd = (d)=> {
  const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};

async function apiFetch(path, { method='GET', headers={}, body=null, raw=false }={}){
  const { base, key } = assertConfig();
  const url = `${base}${path.startsWith('/')?'': '/'}${path}`;
  const reqId = Math.random().toString(36).slice(2,9);

  const hdrs = new Headers(headers || {});
  if(!hdrs.has('X-API-Key')) hdrs.set('X-API-Key', key);

  log('info',`HTTP ${method} ${url}`, '→ request');
  log('info', JSON.stringify({ id:reqId, method, url, reqHeaders:Object.fromEntries(hdrs.entries()) }));

  const res = await fetch(url, { method, headers: hdrs, body });
  const text = await res.text();
  log('info',`HTTP ${method} ${url}`, `← ${res.status} ${res.statusText} (${res.headers.get('content-length')||''?'' : ''})`);
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch{ data = text; }
  log('info', JSON.stringify({
    id:reqId, dur: undefined, status: res.status,
    resHeaders: Object.fromEntries(res.headers.entries()), body: typeof data==='string'?data:JSON.stringify(data)+"\n"
  }));

  if(!res.ok){
    const err = new Error(`HTTP ${res.status} ${res.statusText} — ${typeof data==='string'?data:JSON.stringify(data)}`);
    log('error',`HTTP ${method} ${url}`, `✖ ${err.message}`);
    throw err;
  }
  return data;
}

/* =========================== Conferences =========================== */
async function listConferences(){
  const j = await apiFetch('/conferences', { headers: { 'Accept':'application/json' } });
  return (j && j.data) || [];
}
async function createConference({ name, start_date, end_date, website_url, goals }){
  const j = await apiFetch('/conferences', {
    method:'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ name, start_date, end_date, website_url, goals })
  });
  return j.data;
}
async function getConference(id){
  const j = await apiFetch(`/conferences/${id}`);
  return j.data;
}

/* =========================== Vendors =========================== */
async function listVendors(){
  const j = await apiFetch('/vendors', { headers: { 'Accept':'application/json' } });
  return (j && j.data) || [];
}
async function listVendorsForConference(conference_id){
  const j = await apiFetch(`/conferences/${conference_id}/vendors`, { headers: { 'Accept':'application/json' } });
  // API returns {count, data, success}; data is array
  return (j && j.data) || [];
}
async function createVendor(payload){
  const j = await apiFetch('/vendors', {
    method:'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });
  return j.data;
}
async function getVendorDetail(id){
  const j = await apiFetch(`/vendors/${id}`, { headers: { 'Accept':'application/json' } });
  return j.data;
}

/* =========================== Sessions =========================== */
// Step 1: JSON create (must use user_notes, NOT notes)
async function createSessionJson({ vendor_id, conference_id, start_time, end_time, user_notes, local_transcription, gps_latitude, gps_longitude }){
  const body = {
    vendor_id, conference_id, start_time,
    ...(end_time ? { end_time } : {}),
    ...(local_transcription ? { local_transcription } : {}),
    ...(typeof user_notes === 'string' ? { user_notes } : {}),
    ...(typeof gps_latitude === 'number' ? { gps_latitude } : {}),
    ...(typeof gps_longitude === 'number' ? { gps_longitude } : {}),
  };
  const j = await apiFetch('/sessions/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept':'application/json' },
    body: JSON.stringify(body)
  });
  // API KB says data.id is returned
  return j.data;
}

// Step 2: add files via multipart
async function addFilesToSession(sessionId, { audioBlob=null, imageFiles=[] /*, notes*/ }={}){
  const fd = new FormData();
  if(audioBlob && audioBlob.blob){
    fd.append('audio_files', audioBlob.blob, audioBlob.name || 'audio.webm');
  }
  if(imageFiles && imageFiles.length){
    for(const f of imageFiles){
      fd.append('image_files', f, f.name);
    }
  }
  // We intentionally DO NOT set Content-Type; browser sets multipart boundary.
  const j = await apiFetch(`/sessions/${sessionId}/add-files`, {
    method:'POST',
    headers: { /* only API key is needed; do not set Content-Type */ },
    body: fd
  });
  return j;
}

/* =========================== Unknown entities =========================== */
async function ensureUnknownEntities(confId, vendId){
  // Returns {conference_id, vendor_id}
  if(confId && vendId) return { conference_id: confId, vendor_id: vendId };

  const today = ymd(new Date());
  let conference_id = confId || null;
  let vendor_id = vendId || null;

  if(!conference_id){
    // Try to find an "Unknown Conference"
    const all = await listConferences();
    const found = all.find(c => /^unknown conference$/i.test(c.name));
    if(found){ conference_id = found.id; }
    else{
      try{
        const c = await createConference({ name: 'Unknown Conference', start_date: today, end_date: today });
        conference_id = c.id;
      }catch(e){
        log('warn','Could not create Unknown Conference automatically; using first conference if available.');
        if(all.length) conference_id = all[0].id;
        else throw e;
      }
    }
  }

  if(!vendor_id){
    // try to find Unknown Vendor for this conference
    const vlist = await listVendorsForConference(conference_id);
    const fv = vlist.find(v=>/^unknown vendor$/i.test(v.name));
    if(fv){ vendor_id = fv.id; }
    else{
      const v = await createVendor({ name:'Unknown Vendor', conference_id });
      vendor_id = v.id;
    }
  }

  return { conference_id, vendor_id };
}

/* =========================== Self Test =========================== */
async function selfTest(){
  // 1. health
  await apiFetch('/health', { headers: { 'Accept':'application/json' } });
  // 2. conferences list
  await listConferences();
  // 3. vendors list
  await listVendors();
  log('info','Self-test passed.');
  return true;
}

/* =========================== Exports =========================== */
export {
  setConfig, getConfig, assertConfig,
  log, logsToJson, logsToText, clearLogs,
  nowIso, ymd,
  listConferences, createConference, getConference,
  listVendors, listVendorsForConference, createVendor, getVendorDetail,
  ensureUnknownEntities,
  createSessionJson, addFilesToSession,
  selfTest
};
