/* cb-api.js — Conference Buddy API layer (mobile-safe)
   Changes in v7:
   - Upload order = JSON first (application/json) → multipart fallback
   - Use `user_notes` everywhere; never send `notes` or `text`
   - When JSON: include audio_base64, images_base64[]
   - When multipart: DO NOT set Content-Type; include `user_notes` field
*/
(function(global){
  'use strict';

  const logs = [];
  const listeners = new Set();

  function log(msg, level='info', extra=''){
    const entry = { t:new Date().toISOString(), level, msg, extra };
    logs.push(entry);
    listeners.forEach(fn=>{ try{ fn(entry); }catch{} });
  }
  function onLog(fn){ listeners.add(fn); }
  function getLogs(){ return logs.slice(); }
  function todayISO(){ return new Date().toISOString().slice(0,10); }

  let CFG = { url:'', key:'', mode:'xapikey', param:'apiKey' };
  function saveCfg(){ try{ localStorage.setItem('cb_cfg', JSON.stringify(CFG)); }catch{} }
  function loadCfg(){ try{ const raw=localStorage.getItem('cb_cfg'); if(raw) CFG={...CFG, ...JSON.parse(raw)}; }catch{} }
  loadCfg();
  function setConfig({url,key,mode,param}){ if(url!==undefined) CFG.url=url; if(key!==undefined) CFG.key=key; if(mode!==undefined) CFG.mode=mode; if(param!==undefined) CFG.param=param||'apiKey'; saveCfg(); log('Config updated.'); }
  function getConfig(){ return {...CFG}; }

  function authHeadersAndUrl(u){
    const headers = {};
    let url = u;
    if(CFG.mode==='xapikey'){ headers['X-API-Key'] = CFG.key; }
    else if(CFG.mode==='bearer'){ headers['Authorization'] = 'Bearer '+CFG.key; }
    else if(CFG.mode==='query'){
      const sep = url.includes('?')?'&':'?';
      url = `${url}${sep}${encodeURIComponent(CFG.param||'apiKey')}=${encodeURIComponent(CFG.key)}`;
    }
    return { headers, url };
  }

  async function req(method, path, { headers={}, body, raw=false }={}){
    if(!CFG.url) throw new Error('API base URL not configured.');
    const base = CFG.url.replace(/\/+$/,'');
    let url = `${base}${path.startsWith('/')?'':'/'}${path}`;
    const auth = authHeadersAndUrl(url); url = auth.url;
    const h = { ...auth.headers, ...headers };
    const id = Math.random().toString(36).slice(2,9);
    const started = performance.now();
    log(`HTTP ${method} ${url}`, 'info', '→ request');
    log(JSON.stringify({
      id, method, url,
      reqHeaders: Object.fromEntries(Object.entries(h).map(([k,v])=>[k,k==='X-API-Key'?'***':v]))
    }));
    let res, text;
    try{
      res = await fetch(url, { method, headers:h, body, mode:'cors' });
      text = await res.text();
    }catch(e){
      log(`HTTP ${method} ${url}`, 'error', `✖ Failed to fetch (${(performance.now()-started|0)}ms)`);
      throw e;
    }
    const dur = (performance.now()-started|0);
    let data = text; try{ data = text ? JSON.parse(text) : null; }catch{}
    log(`HTTP ${method} ${url}`, 'info', `← ${res.status} ${(res.statusText||'')} (${dur}ms)`);
    log(JSON.stringify({
      id, dur:String(dur), status:res.status,
      resHeaders: Object.fromEntries(res.headers.entries()),
      body: raw? text : (typeof data==='string'? data : JSON.stringify(data))
    }));
    if(!res.ok){
      const err = new Error(`HTTP ${res.status} ${res.statusText||''} — ${typeof data==='string'?data:JSON.stringify(data)}`);
      err.status = res.status; err.data = data; throw err;
    }
    return raw ? text : data;
  }

  // ===== Public API =====
  async function testConnectivity(){
    // Visibility for OPTIONS (CORS preflight)
    try{
      const {url} = authHeadersAndUrl(CFG.url.replace(/\/+$/,'') + '/conferences');
      log(`HTTP OPTIONS ${url}`, 'info', '→ request');
      const res = await fetch(url, { method:'OPTIONS' });
      log(`HTTP OPTIONS ${url}`, 'info', `← ${res.status} ${(res.statusText||'')}`);
    }catch{}
    await req('GET','/health');
    await listConferences();
  }

  async function listConferences(){
    const r = await req('GET','/conferences');
    if(Array.isArray(r)) return r;
    if(r?.data && Array.isArray(r.data)) return r.data;
    return [];
  }
  async function listVendorsForConference(confId){
    const r = await req('GET', `/conferences/${encodeURIComponent(confId)}/vendors`);
    if(Array.isArray(r)) return r;
    if(r?.data && Array.isArray(r.data)) return r.data;
    return [];
  }
  async function listAllVendors(){
    const r = await req('GET','/vendors');
    if(Array.isArray(r)) return r;
    if(r?.data && Array.isArray(r.data)) return r.data;
    return [];
  }
  async function createConference({name,start_date,end_date}){
    const payload = { name, start_date, end_date };
    const r = await req('POST','/conferences',{ headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    return r?.data || r;
  }
  async function createVendor({name,conference_id}){
    const payload = { name, conference_id };
    const r = await req('POST','/vendors',{ headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    return r?.data || r;
  }

  async function ensureConferenceVendor({conferenceId, vendorId, preferredVendorName='Unknown Vendor'}){
    if(!conferenceId){
      const sd=todayISO();
      const conf = await createConference({ name:'Unknown Conference', start_date:sd, end_date:sd });
      conferenceId = conf?.id??conf?._id??conf?.uuid;
      log(`Created fallback conference: ${conferenceId}`);
    }
    if(!vendorId){
      const vendor = await createVendor({ name: preferredVendorName||'Unknown Vendor', conference_id: conferenceId });
      vendorId = vendor?.id??vendor?._id??vendor?.uuid;
      log(`Created fallback vendor: ${vendorId}`);
    }
    return { conferenceId, vendorId };
  }

  async function listSessionsForVendor(vendorId){
    const r = await req('GET', `/vendors/${encodeURIComponent(vendorId)}`);
    if(r?.data?.sessions && Array.isArray(r.data.sessions)) return r.data.sessions;
    if(Array.isArray(r?.sessions)) return r.sessions;
    if(Array.isArray(r)) return r;
    return [];
  }
  async function getVendor(vendorId){
    const r = await req('GET', `/vendors/${encodeURIComponent(vendorId)}`);
    return r?.data || r;
  }
  async function getSession(sessionId){
    const r = await req('GET', `/sessions/${encodeURIComponent(sessionId)}`);
    return r?.data || r;
  }
  async function getSessionReport(sessionId){
    const r = await req('GET', `/sessions/${encodeURIComponent(sessionId)}/report`);
    return r?.data || r;
  }

  // ===== Upload logic (JSON first; multipart fallback) =====
  async function uploadSession({ audioBlob, images=[], text='', conferenceId, vendorId, startIso, endIso }){
    const path = '/sessions/upload';

    // Helper: Blob -> base64 (no data: prefix)
    const toB64 = blob => new Promise((resolve,reject)=>{
      const r=new FileReader();
      r.onloadend=()=>resolve(String(r.result).split(',')[1]||'');
      r.onerror=reject;
      r.readAsDataURL(blob);
    });

    // ---------- 1) JSON (recommended by backend) ----------
    try{
      const audio_base64 = audioBlob ? await toB64(audioBlob) : '';
      const images_base64 = [];
      for (const f of (images||[])) images_base64.push(await toB64(f));

      const payload = {
        conference_id: conferenceId||'',
        vendor_id: vendorId||'',
        start_time: startIso||new Date().toISOString(),
        end_time: endIso||startIso||new Date().toISOString(),
        session_type: 'conversation',
        user_notes: text||'',
        audio_base64,
        images_base64
      };

      const r = await req('POST', path, {
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });

      const sid = r?.data?.id || r?.id || r?.session_id || r?.sessionId;
      // Trigger enrichment (best-effort)
      try{ if(sid) await req('POST', `/sessions/${encodeURIComponent(sid)}/enrich`); }catch(e){ log('Enrich trigger failed (non-fatal): '+e.message,'warn'); }
      return sid || '(unknown)';
    }catch(e){
      // If backend genuinely rejects JSON (unlikely given new guidance), fall back to multipart
      log(`JSON upload failed: ${e.message}. Falling back to multipart…`, e.status===415?'warn':'warn');
    }

    // ---------- 2) Multipart (files) ----------
    // DO NOT set Content-Type; browser sets it with boundary.
    const form = new FormData();
    form.append('conference_id', conferenceId||'');
    form.append('vendor_id', vendorId||'');
    form.append('start_time', startIso||new Date().toISOString());
    form.append('end_time', endIso||startIso||new Date().toISOString());
    form.append('session_type','conversation');
    if (text) form.append('user_notes', text); // <-- correct field name

    if (audioBlob) {
      const audioName = `audio.${(audioBlob?.type||'audio/webm').includes('mp4')?'mp4':'webm'}`;
      form.append('audio', audioBlob, audioName);
    }
    (images||[]).forEach((f,i)=> form.append('images', f, f.name||`photo_${i+1}.jpg`));

    // Manual fetch to avoid auto adding Content-Type
    const { headers, url } = authHeadersAndUrl(CFG.url.replace(/\/+$/,'') + path);
    const id = Math.random().toString(36).slice(2,9);
    log(`HTTP POST ${url}`, 'info', '→ request');
    const res = await fetch(url, { method:'POST', headers, body: form, mode:'cors' });
    const textRes = await res.text();
    let data = textRes; try{ data = textRes? JSON.parse(textRes):null; }catch{}
    log(`HTTP POST ${url}`, 'info', `← ${res.status} ${(res.statusText||'')}`);
    log(JSON.stringify({ id, status:res.status, resHeaders:Object.fromEntries(res.headers.entries()), body: typeof data==='string'?data:JSON.stringify(data) }));

    if(!res.ok){
      const err=new Error((typeof data==='string'?data:JSON.stringify(data))||('HTTP '+res.status));
      err.status=res.status; err.data=data; throw err;
    }

    const sid = data?.data?.id || data?.id || data?.session_id || data?.sessionId;
    try{ if(sid) await req('POST', `/sessions/${encodeURIComponent(sid)}/enrich`);}catch(e){ log('Enrich trigger failed (non-fatal): '+e.message,'warn'); }
    return sid || '(unknown)';
  }

  async function runSelfTest(){
    const out=[]; const push = s => { out.push(s); log(s); };
    try{
      try{
        const {url} = authHeadersAndUrl(CFG.url.replace(/\/+$/,'') + '/conferences');
        push(`OPTIONS ${url} → starting`);
        const res = await fetch(url, { method:'OPTIONS' }); push(`OPTIONS ${url} ← ${res.status}`);
      }catch(e){ push(`OPTIONS failed: ${e.message}`); }

      await req('GET','/health'); push('GET /health ✓');

      const confs = await listConferences(); push(`GET /conferences ✓ (${confs.length})`);

      const sd=todayISO();
      const conf = await createConference({ name:'SelfTest '+sd, start_date:sd, end_date:sd });
      const cid = conf?.id??conf?._id??conf?.uuid; push(`POST /conferences ✓ (${cid||'unknown'})`);

      const vendor = await createVendor({ name:'SelfVendor', conference_id: cid });
      const vid = vendor?.id??vendor?._id??vendor?.uuid; push(`POST /vendors ✓ (${vid||'unknown'})`);

      const blob = new Blob([new Uint8Array(500)], {type:'audio/webm'});
      const sid = await uploadSession({
        audioBlob: blob, images: [], text:'self-test via JSON user_notes',
        conferenceId: cid, vendorId: vid,
        startIso:new Date().toISOString(), endIso:new Date().toISOString()
      });
      push(`POST /sessions/upload ✓ (${sid||'unknown'})`);

      try{ await req('POST', `/sessions/${encodeURIComponent(sid||'')}/enrich`); push('POST /sessions/{id}/enrich ✓'); }catch(e){ push('enrich warn: '+e.message); }
      try{ await getSessionReport(sid||''); push('GET /sessions/{id}/report ✓'); }catch(e){ push('report warn: '+e.message); }
    }catch(e){
      push(`✖ Self-Test failed: ${e.message}`); throw e;
    }
    return out;
  }

  // Expose
  global.CBAPI = {
    onLog, getLogs, log,
    setConfig, getConfig, todayISO,
    testConnectivity,
    listConferences, listVendorsForConference, listAllVendors,
    createConference, createVendor, ensureConferenceVendor,
    listSessionsForVendor, getVendor, getSession, getSessionReport,
    uploadSession, runSelfTest
  };
})(window);
