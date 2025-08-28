<script>
/* ============================================================
   ConferenceBuddy – Stable Mobile Upload Flow (2-Step)
   - Step 1: POST /api/mobile/sessions/create (JSON)
   - Step 2: POST /api/mobile/sessions/{id}/upload-batch (multipart)
   - Progress check: GET /api/sessions/{id}
   - Trigger enrichment: POST /api/sessions/{id}/trigger-enrichment
   - Fallback: POST /api/sessions/upload (multipart) if mobile endpoints fail
   - Multi-image support; robust audio handling (m4a/mp3/wav/aac/ogg)
   - Clears notes/photos/audio after success
   - Detailed request/response logging
   ============================================================ */

(function () {
  // ---------- Element helpers ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    apiBase: $('apiBase'),
    apiKey: $('apiKey'),
    conf: $('conferenceSelect'),
    vend: $('vendorSelect'),
    notes: $('notesInput'),
    photos: $('photoInput'),
    audioFile: $('audioFileInput'),
    startBtn: $('startBtn'),
    stopBtn: $('stopBtn'),
    uploadBtn: $('uploadBtn'),
    logs: $('logs'),
    sessionsList: $('sessionsList')
  };

  // ---------- Logger ----------
  function log(level, msg, extraObj) {
    const now = new Date().toISOString();
    const rec = { t: now, level, msg, extra: extraObj ? JSON.stringify(extraObj) : "" };
    const line = JSON.stringify(rec) + "\n";
    if (els.logs) els.logs.value = (els.logs.value || "") + line;
    // console in dev tools as well
    if (level === 'error') console.error(rec); else if (level === 'warn') console.warn(rec); else console.info(rec);
  }

  // ---------- Config ----------
  function getCfg() {
    const base = (els.apiBase?.value || '').trim().replace(/\/+$/, '');
    const key = (els.apiKey?.value || '').trim();
    if (!base) throw new Error("API base URL is required.");
    if (!key) throw new Error("API key is required.");
    return { base, key };
  }

  function authHeaders(extra = {}) {
    const { key } = getCfg();
    return { 'X-API-Key': key, ...extra };
  }

  async function httpJSON(method, url, bodyObj) {
    log('info', `HTTP ${method} ${url}`, { headers: { ...authHeaders({'Accept':'application/json','Content-Type':'application/json'}) } });
    const res = await fetch(url, {
      method,
      headers: authHeaders({ 'Accept': 'application/json', 'Content-Type': 'application/json' }),
      body: bodyObj ? JSON.stringify(bodyObj) : undefined
    });
    const txt = await res.text();
    let json;
    try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
    log('info', `HTTP ${method} ${url} ← ${res.status}`, { status: res.status, body: json });
    if (!res.ok) {
      throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status, details: json });
    }
    return json;
  }

  async function httpForm(method, url, formData) {
    // DO NOT set Content-Type (browser sets multipart boundary)
    log('info', `HTTP ${method} ${url}`, { headers: { ...authHeaders({'Accept':'application/json'}) }, form: safeFormPreview(formData) });
    const res = await fetch(url, { method, headers: authHeaders({ 'Accept': 'application/json' }), body: formData });
    const txt = await res.text();
    let json;
    try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
    log('info', `HTTP ${method} ${url} ← ${res.status}`, { status: res.status, body: json });
    if (!res.ok) {
      throw Object.assign(new Error(json?.error || `HTTP ${res.status}`), { status: res.status, details: json });
    }
    return json;
  }

  function safeFormPreview(fd) {
    // For logging: show keys & filenames, not binary
    const summary = {};
    for (const [k, v] of fd.entries()) {
      if (v instanceof File || v instanceof Blob) {
        summary[k] = summary[k] || [];
        const name = (v instanceof File && v.name) ? v.name : `blob(${v.type||'unknown'})`;
        summary[k].push({ name, size: v.size, type: v.type });
      } else {
        summary[k] = summary[k] || [];
        summary[k].push(String(v));
      }
    }
    return summary;
  }

  // ---------- Audio handling (mobile-safe) ----------
  function normalizeAudioFile(fileOrBlob) {
    if (!fileOrBlob) return null;
    const allowed = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/aac','audio/x-aac','audio/mp4','audio/m4a','audio/x-m4a','audio/ogg','application/ogg'];
    const okType = allowed.includes(fileOrBlob.type);
    const guessedName = (fileOrBlob.name && typeof fileOrBlob.name === 'string') ? fileOrBlob.name : '';
    const hasKnownExt = /\.(mp3|wav|m4a|aac|ogg)$/i.test(guessedName);

    // If type or extension looks off (e.g., Safari gives audio/x-m4a), rewrap with a safe MIME & filename
    if (!okType || !hasKnownExt) {
      // Choose an extension by best guess
      let ext = 'm4a';
      if (/ogg/i.test(fileOrBlob.type) || /\.ogg$/i.test(guessedName)) ext = 'ogg';
      else if (/wav/i.test(fileOrBlob.type) || /\.wav$/i.test(guessedName)) ext = 'wav';
      else if (/mp3|mpeg/i.test(fileOrBlob.type) || /\.mp3$/i.test(guessedName)) ext = 'mp3';
      else if (/aac/i.test(fileOrBlob.type) || /\.aac$/i.test(guessedName)) ext = 'aac';

      const typeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/m4a', aac: 'audio/aac', ogg: 'audio/ogg' };
      const safeType = typeMap[ext] || 'audio/m4a';
      const safeName = guessedName && !hasKnownExt
        ? guessedName.replace(/\.[^.]+$/, '') + '.' + ext
        : (guessedName || `session_audio.${ext}`);

      try {
        // Rewrap as File so server sees a filename with accepted extension
        return new File([fileOrBlob], safeName, { type: safeType });
      } catch {
        // Older browsers: fall back to Blob (server will still get a part; filename may be missing)
        const blob = new Blob([fileOrBlob], { type: safeType });
        blob.name = safeName; // non-standard, but some servers read it
        return blob;
      }
    }
    return fileOrBlob;
  }

  // ---------- Core flow ----------
  async function createMobileSession({ vendorId, conferenceId, startISO, userNotes }) {
    const { base } = getCfg();
    const url = `${base}/api/mobile/sessions/create`;
    const payload = {
      vendor_id: vendorId,
      conference_id: conferenceId,
      start_time: startISO,
      user_notes: userNotes || ""
    };
    const res = await httpJSON('POST', url, payload);
    const sessionId = res?.session_id || res?.data?.id || res?.id;
    if (!sessionId) throw new Error("Create session response missing session_id.");
    return sessionId;
  }

  async function uploadBatchToMobile(sessionId, { audio, images, notes, endISO }) {
    const { base } = getCfg();
    const url = `${base}/api/mobile/sessions/${encodeURIComponent(sessionId)}/upload-batch`;
    const fd = new FormData();
    if (audio) fd.append('audio_file', audio);
    if (Array.isArray(images)) {
      images.forEach((f) => fd.append('business_card_images', f));
    }
    if (notes) fd.append('notes', notes);
    if (endISO) fd.append('end_time', endISO);
    return httpForm('POST', url, fd);
  }

  async function getSession(sessionId) {
    const { base } = getCfg();
    const url = `${base}/api/sessions/${encodeURIComponent(sessionId)}`;
    return httpJSON('GET', url);
  }

  async function triggerEnrichment(sessionId) {
    const { base } = getCfg();
    const url = `${base}/api/sessions/${encodeURIComponent(sessionId)}/trigger-enrichment`;
    return httpJSON('POST', url, {});
  }

  // Fallback: one-shot upload endpoint (if mobile endpoints aren’t available)
  async function fallbackOneShotUpload({ vendorId, conferenceId, startISO, endISO, audio, images, notes }) {
    const { base } = getCfg();
    const url = `${base}/api/sessions/upload`;
    const fd = new FormData();
    fd.append('vendor_id', vendorId);
    fd.append('conference_id', conferenceId);
    fd.append('start_time', startISO);
    if (endISO) fd.append('end_time', endISO);
    if (notes) fd.append('user_notes', notes);

    if (audio) fd.append('audio_file', audio);
    if (Array.isArray(images)) images.forEach((f) => fd.append('photos', f));

    return httpForm('POST', url, fd);
  }

  // Poll status a few times to confirm the server picked up the files
  async function pollProgress(sessionId, tries = 5, delayMs = 1500) {
    for (let i = 0; i < tries; i++) {
      const s = await getSession(sessionId);
      const processing = s?.data?.processing_status || s?.processing_status || s?.status;
      log('info', 'Progress check', { sessionId, processing });
      if (processing && processing !== 'created') return processing;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return 'unknown';
  }

  // ---------- UI wiring (no UI changes required) ----------
  // If you still use start/stop buttons for MediaRecorder, we no-op here (you asked not to change UI).
  // We rely on the file picker (audioFileInput) for consistent mobile uploads.

  // Show the chosen audio file type (useful for debugging)
  if (els.audioFile) {
    els.audioFile.addEventListener('change', () => {
      const f = els.audioFile.files?.[0];
      if (f) log('info', `Audio file selected: ${f.name} (${(f.size/1024/1024).toFixed(2)} MB)`, { type: f.type });
    });
  }

  async function doUploadFlow() {
    try {
      const { conf, vend, notes, photos, audioFile } = els;
      const conferenceId = conf?.value || "";
      const vendorId = vend?.value || "";
      if (!conferenceId) throw new Error('Please select a Conference.');
      if (!vendorId) throw new Error('Please select a Vendor.');

      const userNotes = (notes?.value || "").trim();
      const imageFiles = photos?.files ? Array.from(photos.files) : [];
      const rawAudio = audioFile?.files?.[0] || null;
      const audio = normalizeAudioFile(rawAudio);

      const startISO = new Date().toISOString();

      // 1) Create session (mobile create)
      log('info', 'Creating session (mobile) …', { conferenceId, vendorId, startISO });
      let sessionId = await createMobileSession({ vendorId, conferenceId, startISO, userNotes });

      // 2) Upload files to that session (batch)
      const endISO = new Date().toISOString();
      log('info', 'Uploading batch to mobile endpoint …', { sessionId, hasAudio: !!audio, imageCount: imageFiles.length });
      try {
        await uploadBatchToMobile(sessionId, {
          audio,
          images: imageFiles,
          notes: userNotes,
          endISO
        });
      } catch (e) {
        // Some deployments only expose the one-shot endpoint; fall back seamlessly.
        log('warn', 'Mobile upload-batch failed; falling back to /api/sessions/upload …', { err: e?.message || String(e) });
        const fallback = await fallbackOneShotUpload({
          vendorId, conferenceId, startISO, endISO, audio, images: imageFiles, notes: userNotes
        });
        // If fallback returns a new session id, prefer that for progress
        const fbId = fallback?.data?.id || fallback?.session_id || fallback?.id;
        if (fbId) sessionId = fbId;
      }

      // 3) Progress check
      const prog = await pollProgress(sessionId);
      log('info', 'Post-upload progress status', { sessionId, status: prog });

      // 4) Trigger enrichment (explicit)
      try {
        const enr = await triggerEnrichment(sessionId);
        log('info', 'Enrichment triggered', enr);
      } catch (e) {
        // Some servers auto-enrich; don’t fail the UX if this isn’t available.
        log('warn', 'Trigger-enrichment endpoint unavailable; continuing.', { err: e?.message || String(e) });
      }

      // 5) Clear inputs after success
      if (notes) notes.value = '';
      if (photos) photos.value = '';
      if (audioFile) audioFile.value = '';

      alert('Upload complete ✅');
    } catch (err) {
      log('error', 'Upload flow failed', { message: err?.message || String(err), details: err?.details });
      alert(`Upload failed: ${err?.message || 'Unknown error'}`);
    }
  }

  // Wire “Upload” button
  if (els.uploadBtn) {
    els.uploadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      doUploadFlow();
    });
  }

  // Optional: “Start/Stop” buttons can still log, but recording logic is UI-dependent
  if (els.startBtn) els.startBtn.addEventListener('click', () => log('info', 'Start pressed (no-op in this script; use file picker for audio).'));
  if (els.stopBtn) els.stopBtn.addEventListener('click', () => log('info', 'Stop pressed (no-op in this script; use file picker for audio).'));

  // Public helper (if you want to refresh session list externally)
  window.CB = window.CB || {};
  window.CB.refreshSession = async function (sessionId) {
    const s = await getSession(sessionId);
    log('info', 'Session refresh', s);
    return s;
  };
})();
</script>
