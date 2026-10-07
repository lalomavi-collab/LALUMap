// 3-panel cockpit: matter vault, smart editor, practice agent studio with human sign-off gate.
(function () {
  const L = window.LalumCommon;
  const root = document.getElementById('ck-root');
  document.getElementById('ck-nav').innerHTML = L.nav('workspace');
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = L.esc;
  const st = { member: null, matters: [], matter: null, routing: null, docs: [], doc: null, findings: [], risk: null, area: null, analyzedText: '', mode: 'edit', signoff: null, originals: new Map(), dirty: false, timer: null };
  const STEPS = [['FACT_VERIFICATION', 'אימות עובדות'], ['CITATION_CHECK', 'בדיקת אסמכתאות'], ['REDLINE_REVIEW', 'סקירת שינויים (Redline)'], ['PARTNER_APPROVAL', 'אישור שותף']];
  const KIND_HE = { ID_NUMBER: 'ת.ז. / דרכון', COMPANY_REG: 'ח.פ. / ח.צ.', EMAIL: 'דוא"ל', PHONE: 'טלפון', LAND_PARCEL: 'גוש / חלקה', CLIENT_NAME: 'שם צד', BANK_ACCOUNT: 'חשבון בנק' };

  // ---------- helpers ----------
  const badge = (sev) => ({ RED: '<span class="ck-badge red">🔴 סיכון גבוה</span>', YELLOW: '<span class="ck-badge yellow">🟡 זהירות</span>', GREEN: '<span class="ck-badge green">🟢 תקין</span>' }[sev]);
  const conflictBadge = (c) => { const [t, l] = L.CONFLICT[c] || ['yellow', c]; return `<span class="ck-badge ${t}">${esc(l)}</span>`; };
  const piiBadge = '<span class="pii-badge" title="מידע מזהה הוסתר לפני כל עיבוד חיצוני">🔒 PII Masked &amp; Secured</span>';
  const tokenKind = (tok) => { const m = /^\[([A-Z_]+)_\d+\]$/.exec(tok); return m ? m[1] : ''; };

  function diffWords(a, b) {
    const A = a.split(/(\s+)/).filter((x) => x !== ''), B = b.split(/(\s+)/).filter((x) => x !== '');
    let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    const midA = A.slice(s, ea), midB = B.slice(s, eb);
    const ops = A.slice(0, s).map((t) => ['=', t]);
    if (midA.length * midB.length > 4e6) {
      midA.forEach((t) => ops.push(['-', t])); midB.forEach((t) => ops.push(['+', t]));
    } else {
      const n = midA.length, m = midB.length, w = m + 1, dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (midA[i] === midB[j]) { ops.push(['=', midA[i]]); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(['-', midA[i++]]);
        else ops.push(['+', midB[j++]]);
      }
      while (i < n) ops.push(['-', midA[i++]]);
      while (j < m) ops.push(['+', midB[j++]]);
    }
    A.slice(ea).forEach((t) => ops.push(['=', t]));
    return ops;
  }
  const redlineHTML = (base, cur) => diffWords(base, cur).map(([o, t]) => (o === '=' ? esc(t) : o === '+' ? `<ins>${esc(t)}</ins>` : `<del>${esc(t)}</del>`)).join('');

  const tokenMap = (docId) => {
    const o = st.originals.get(docId);
    if (!o) return null;
    const map = new Map();
    for (const e of o.entities) if (!map.has(e.token)) map.set(e.token, o.text.slice(e.start, e.end));
    return map;
  };
  const restoreTokens = (text, map) => text.replace(/\[[A-Z_]+_\d+\]/g, (t) => (map.has(t) ? map.get(t) : t));

  // ---------- data ----------
  async function loadMatters() {
    const { data, error } = await L.safely(L.client.from('lalum_v_admin_matters').select('*').order('dispatched_at', { ascending: false }).limit(100));
    if (error) return [];
    return data || [];
  }

  async function readFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.docx')) {
      if (!window.mammoth) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js'; s.onload = res; s.onerror = () => rej(new Error('mammoth')); document.head.appendChild(s); });
      const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return r.value;
    }
    if (name.endsWith('.pdf')) throw new Error('קבצי PDF אינם נתמכים עדיין. הדביקו את הטקסט או העלו DOCX / TXT.');
    const text = await file.text();
    if (name.endsWith('.html') || name.endsWith('.htm')) return new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
    return text;
  }

  // ---------- list view ----------
  async function renderList() {
    history.replaceState(null, '', location.pathname);
    const matters = (st.matters = await loadMatters());
    const m = st.member;
    root.innerHTML = `
      <div class="card"><div class="card-row"><div><div class="card-title">${esc(m.lalum_firms.firm_name)}</div>
        <div class="card-meta">${esc(m.name)} · ${esc(L.ROLE[m.role] || m.role)}</div></div>${piiBadge}</div></div>
      <div class="ck-row"><button class="ck-btn primary" id="new-matter-toggle" aria-expanded="false" aria-controls="intake-card">תיק חדש (קליטה אוטומטית)</button></div>
      <div class="card" id="intake-card" hidden>${intakeFormHTML('')}</div>
      <div class="section-label">תיקים</div>
      ${matters.length ? `<div class="ck-table-wrap"><table class="ck-table"><thead><tr><th>תיק</th><th>תחום</th><th>סטטוס</th><th>ניגוד עניינים</th><th>סיכון</th><th>תגובת שותף</th><th>נקלט</th></tr></thead><tbody>
        ${matters.map((x) => `<tr class="${x.sla_breached ? 'sla-breach' : ''}"><td><a href="?matter=${esc(x.matter_id)}" data-open="${esc(x.matter_id)}" style="text-decoration:underline">${esc(x.title)}</a></td><td>${esc(L.PRACTICE[x.practice_area] || '')}</td><td>${esc(L.MATTER_STATUS[x.matter_status] || '')}</td><td>${conflictBadge(x.conflict_status)}</td><td>${x.risk_level === 'HIGH_RISK' ? badge('RED') : x.risk_level === 'CAUTION' ? badge('YELLOW') : badge('GREEN')}</td><td>${esc(L.RESPONSE[x.partner_response] || '')}</td><td>${esc(L.fmt(x.dispatched_at))}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="card"><div class="card-meta">אין תיקים עדיין. פתחו תיק חדש כדי להתחיל.</div></div>'}`;
    wireIntake($('#intake-card'), null);
    $('#new-matter-toggle').addEventListener('click', (e) => {
      const c = $('#intake-card'); c.hidden = !c.hidden; e.currentTarget.setAttribute('aria-expanded', String(!c.hidden));
    });
    root.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openMatter(a.dataset.open); }));
  }

  function intakeFormHTML(matterId) {
    const p = (k, t) => `<label class="ck-field">${t}<input class="ck-input" name="${k}" autocomplete="off"></label>`;
    return `<form class="ck-stack intake-form" data-matter="${esc(matterId)}">
      <div class="ck-warn">הטקסט עובר הסתרת מידע מזהה (PII), בדיקת ניגוד עניינים וניתוח פלייבוק לפני שנשמר. המקור אינו נשמר בשרת.</div>
      ${matterId ? '' : `<div class="ck-grid2">${p('title', 'כותרת התיק (אופציונלי)')}
      <label class="ck-field">תחום<select class="ck-select" name="practice_area"><option value="">זיהוי אוטומטי</option>${Object.entries(L.PRACTICE).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label></div>`}
      <div class="ck-grid2">${p('client_name', 'שם הלקוח')}${p('client_id', 'ת.ז. / ח.פ. של הלקוח')}${p('adverse_name', 'שם הצד שכנגד')}${p('adverse_id', 'ת.ז. / ח.פ. של הצד שכנגד')}</div>
      <label class="ck-field">קובץ (DOCX, TXT, MD, HTML)<input class="ck-input" type="file" name="file" accept=".docx,.txt,.md,.html,.htm"></label>
      <label class="ck-field">או הדביקו טקסט<textarea class="ck-textarea" name="text" placeholder="הדביקו כאן חוזה, פנייה או הודעה"></textarea></label>
      <div class="ck-row"><button class="ck-btn primary" type="submit">קליטה וניתוח</button></div>
      <div class="intake-status" aria-live="polite"></div></form>`;
  }

  function wireIntake(container, matterId) {
    const form = container.querySelector('.intake-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form), status = form.querySelector('.intake-status'), btn = form.querySelector('button[type=submit]');
      let text = String(f.get('text') || '').trim(), fileName = null;
      try {
        const file = form.querySelector('input[type=file]').files[0];
        if (file) { text = (await readFile(file)).trim(); fileName = file.name; }
      } catch (err) { status.innerHTML = `<div class="ck-err">${esc(err.message)}</div>`; return; }
      if (!text) { status.innerHTML = '<div class="ck-err">לא הוזן טקסט.</div>'; return; }
      const parties = [];
      if (f.get('client_name') || f.get('client_id')) parties.push({ role: 'CLIENT', name: String(f.get('client_name') || '') || undefined, idNumber: String(f.get('client_id') || '') || undefined });
      if (f.get('adverse_name') || f.get('adverse_id')) parties.push({ role: 'ADVERSE', name: String(f.get('adverse_name') || '') || undefined, idNumber: String(f.get('adverse_id') || '') || undefined });
      btn.disabled = true; status.innerHTML = '<span class="ck-note">מעבד: הסתרת מידע מזהה, ניגוד עניינים, ניתוח...</span>';
      const r = await L.fn('/api/v1/documents/upload', { text, file_name: fileName || undefined, title: String(f.get('title') || '') || undefined, practice_area: String(f.get('practice_area') || '') || undefined, matter_id: matterId || undefined, parties });
      btn.disabled = false;
      if (!r.json.ok) { status.innerHTML = `<div class="${r.json.code === 'CONFLICT_HALT' ? 'ck-warn' : 'ck-err'}">${esc(L.errorText(r))}</div>`; return; }
      st.originals.set(r.json.document_id, { text, entities: r.json.entities }); // in memory only: Zero Data Retention
      openMatter(r.json.matter_id, r.json.document_id);
    });
  }

  // ---------- cockpit ----------
  async function openMatter(id, preferDoc) {
    root.innerHTML = '<div class="ck-note">טוען תיק...</div>';
    history.replaceState(null, '', `?matter=${encodeURIComponent(id)}`);
    const [mr, rr, dr] = await Promise.all([
      L.safely(L.client.from('lalum_cockpit_matters').select('*').eq('id', id).maybeSingle()),
      L.safely(L.client.from('lalum_intake_routings').select('*').eq('matter_id', id).maybeSingle()),
      L.safely(L.client.from('lalum_matter_documents').select('id, file_name, baseline_content, editor_content, entity_counts, analysis, created_at, updated_at').eq('matter_id', id).order('created_at')),
    ]);
    if (!mr.data) { root.innerHTML = '<div class="ck-err">התיק לא נמצא או שאין הרשאה.</div><p><a href="/workspace/" class="ck-btn">חזרה לרשימה</a></p>'; return; }
    st.matter = mr.data; st.routing = rr.data; st.docs = dr.data || [];
    L.client.rpc('lalum_mark_matter_viewed', { p_matter: id }); // sets first_viewed_at once (SLA clock)
    selectDoc(preferDoc || (st.docs[0] && st.docs[0].id));
  }

  async function selectDoc(docId) {
    st.doc = st.docs.find((d) => d.id === docId) || null;
    if (st.doc) {
      const a = st.doc.analysis || {};
      st.findings = a.findings || []; st.risk = a.risk || null; st.area = st.matter.practice_area; st.analyzedText = st.doc.editor_content;
      st.dirty = false; st.mode = 'edit';
      const { data } = await L.safely(L.client.rpc('lalum_doc_signoff_status', { p_doc: st.doc.id }));
      st.signoff = data || null;
    }
    renderCockpit();
  }

  function renderCockpit() {
    const m = st.matter, d = st.doc, role = st.member.role;
    const w1 = localStorage.getItem('ck-w1') || '300px', w3 = localStorage.getItem('ck-w3') || '380px';
    root.innerHTML = `
      <div class="card"><div class="card-row"><div><div class="card-title">${esc(m.title)}</div>
        <div class="ck-row" style="margin-top:6px">${esc(L.PRACTICE[m.practice_area] || '')} ${conflictBadge(m.conflict_status)} <span class="card-meta">${esc(L.MATTER_STATUS[m.status] || '')}</span></div></div>
        <div class="ck-row">${piiBadge}<button class="ck-btn" id="open-pii">בודק PII</button><a class="ck-btn" href="/workspace/" id="back-list">לרשימה</a></div></div>
        ${role === 'FIRM_PARTNER' && st.routing ? `<div class="ck-row" style="margin-top:10px"><label class="ck-note" for="resp">תגובה לתיק:</label>
          <select id="resp" class="ck-select" style="width:auto">${['PENDING_REVIEW', 'ACCEPTED', 'DECLINED', 'CLIENT_CONTACTED'].map((k) => `<option value="${k}"${st.routing.partner_response === k ? ' selected' : ''}${k === 'PENDING_REVIEW' ? ' disabled' : ''}>${esc(L.RESPONSE[k])}</option>`).join('')}</select><span id="resp-status" class="ck-note"></span></div>` : ''}</div>
      <div class="cp-tabs" role="tablist" aria-label="חלוניות"><button class="ck-btn primary" data-tab="1">כספת</button><button class="ck-btn" data-tab="2">עורך</button><button class="ck-btn" data-tab="3">סוכן ואישור</button></div>
      <div class="cp" style="--cp-1:${esc(w1)};--cp-3:${esc(w3)}">
        <section class="cp-panel on" id="panel1" aria-label="כספת תיק"></section>
        <div class="cp-handle" id="h1" role="separator" aria-orientation="vertical" tabindex="0" aria-label="שינוי רוחב"></div>
        <section class="cp-panel on" id="panel2" aria-label="עורך חכם"></section>
        <div class="cp-handle" id="h2" role="separator" aria-orientation="vertical" tabindex="0" aria-label="שינוי רוחב"></div>
        <section class="cp-panel on" id="panel3" aria-label="אולפן סוכני תחום ושער אישור"></section>
      </div>
      <aside class="drawer" id="pii-drawer" hidden aria-label="בודק PII"></aside>`;
    renderPanel1(); renderPanel2(); renderPanel3();
    wireChrome();
  }

  function wireChrome() {
    $('#back-list').addEventListener('click', (e) => { e.preventDefault(); renderList(); });
    $('#open-pii').addEventListener('click', openPiiDrawer);
    const resp = $('#resp');
    if (resp) resp.addEventListener('change', async () => {
      const { error } = await L.safely(L.client.rpc('lalum_set_partner_response', { p_matter: st.matter.id, p_response: resp.value }));
      $('#resp-status').textContent = error ? 'נכשל: ' + error.message : 'נשמר';
    });
    document.querySelectorAll('.cp-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.cp-tabs [data-tab]').forEach((x) => x.classList.toggle('primary', x === b));
      ['panel1', 'panel2', 'panel3'].forEach((p, i) => document.getElementById(p).classList.toggle('on', String(i + 1) === b.dataset.tab));
    }));
    if (window.matchMedia('(max-width:1000px)').matches) { document.getElementById('panel2').classList.remove('on'); document.getElementById('panel3').classList.remove('on'); }
    // resizable columns (RTL: dragging toward the end side widens the end panel)
    const cp = $('.cp');
    const drag = (handleId, varName, key, dir) => {
      const h = document.getElementById(handleId);
      const set = (px) => { const v = Math.max(220, Math.min(640, px)) + 'px'; cp.style.setProperty(varName, v); try { localStorage.setItem(key, v); } catch (e) { /* storage blocked */ } };
      h.addEventListener('pointerdown', (e) => {
        h.setPointerCapture(e.pointerId);
        const startX = e.clientX, start = parseInt(getComputedStyle(cp).getPropertyValue(varName), 10) || 300;
        const move = (ev) => set(start + dir * (ev.clientX - startX));
        const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
      });
      h.addEventListener('keydown', (e) => {
        const cur = parseInt(getComputedStyle(cp).getPropertyValue(varName), 10) || 300;
        if (e.key === 'ArrowLeft') set(cur + dir * 20); if (e.key === 'ArrowRight') set(cur - dir * 20);
      });
    };
    drag('h1', '--cp-1', 'ck-w1', -1); drag('h2', '--cp-3', 'ck-w3', 1);
  }

  // Panel 1: vault & evidence hub
  async function renderPanel1() {
    const p = $('#panel1'), d = st.doc;
    const tokens = d ? [...new Set(d.editor_content.match(/\[[A-Z_]+_\d+\]/g) || [])] : [];
    const counts = d ? d.entity_counts || {} : {};
    p.innerHTML = `<h2>כספת תיק ומרכז ראיות</h2>
      <div class="ck-row">${piiBadge}</div>
      <div><div class="section-label">מסמכים</div><div class="ck-stack">${st.docs.map((x) => `<button class="ck-btn${d && x.id === d.id ? ' primary' : ''}" data-doc="${esc(x.id)}" style="justify-content:flex-start">${esc(x.file_name)}</button>`).join('') || '<span class="ck-note">אין מסמכים</span>'}</div></div>
      <details><summary class="ck-btn" style="display:inline-flex">העלאת מסמך נוסף</summary><div style="margin-top:10px" id="add-doc">${intakeFormHTML(st.matter.id)}</div></details>
      <div><div class="section-label">מפת ישויות</div>${Object.keys(counts).length ? `<div class="ck-row">${Object.entries(counts).map(([k, v]) => `<span class="pill pill-neutral">${esc(KIND_HE[k] || k)}: ${esc(v)}</span>`).join('')}</div>` : '<span class="ck-note">לא זוהו ישויות</span>'}
        ${tokens.length ? `<div class="ck-row" style="margin-top:8px">${tokens.map((t) => `<code class="pill pill-neutral" dir="ltr">${esc(t)}</code>`).join('')}</div>` : ''}</div>
      <div><div class="section-label">ציר זמן</div><ul class="tl" id="timeline"><li>טוען...</li></ul></div>`;
    p.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => selectDoc(b.dataset.doc)));
    wireIntake($('#add-doc'), st.matter.id);
    const events = [];
    const r = st.routing, m = st.matter;
    events.push([m.created_at, 'התיק נקלט וסונן אוטומטית']);
    st.docs.forEach((x) => events.push([x.created_at, `מסמך נוסף: ${x.file_name}`]));
    if (r) { events.push([r.dispatched_at, 'נשלחה התראה לשותף ועותק ביקורת למנהל (בתור שליחה)']); if (r.first_viewed_at) events.push([r.first_viewed_at, 'נפתח לראשונה על ידי עורך דין']); if (r.responded_at) events.push([r.responded_at, `תגובת שותף: ${L.RESPONSE[r.partner_response]}`]); }
    if (d) {
      const { data } = await L.safely(L.client.from('lalum_doc_checklist').select('step, checked_at').eq('document_id', d.id));
      (data || []).forEach((c) => { const s = STEPS.find((x) => x[0] === c.step); if (s) events.push([c.checked_at, `סומן: ${s[1]}`]); });
    }
    events.sort((a, b) => new Date(a[0]) - new Date(b[0]));
    const tl = $('#timeline'); if (tl) tl.innerHTML = events.map(([t, s]) => `<li><time>${esc(L.fmt(t))}</time>${esc(s)}</li>`).join('');
  }

  // Panel 2: editor with track changes, redline and fallback insertion
  function renderPanel2() {
    const p = $('#panel2'), d = st.doc;
    if (!d) { p.innerHTML = '<h2>עורך</h2><span class="ck-note">אין מסמך בתיק.</span>'; return; }
    p.innerHTML = `<h2>עורך חכם ומרחב מסמכים</h2>
      <div class="ck-row"><button class="ck-btn${st.mode === 'edit' ? ' primary' : ''}" data-mode="edit">עריכה</button><button class="ck-btn${st.mode === 'redline' ? ' primary' : ''}" data-mode="redline">מעקב שינויים (Redline)</button>
        <button class="ck-btn" id="save-draft">שמירה</button><button class="ck-btn danger" id="revert">שחזור למסמך המקורי המוסתר</button><span id="save-status" class="ck-note" aria-live="polite"></span></div>
      <div id="hl-box"></div>
      ${st.mode === 'edit' ? `<textarea id="editor" class="editor" dir="rtl" aria-label="עורך המסמך" spellcheck="false">${esc(d.editor_content)}</textarea>`
        : `<div class="editor redline" id="redline" tabindex="0" aria-label="תצוגת שינויים">${redlineHTML(d.baseline_content, d.editor_content)}</div>`}
      <div class="ck-note">הטקסט המוצג מוסתר מפרטים מזהים. כל שמירה עוברת שוב הסתרה אוטומטית. שינוי בטקסט מבטל אישורים קודמים.</div>`;
    p.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { syncEditor(); st.mode = b.dataset.mode; renderPanel2(); }));
    $('#save-draft').addEventListener('click', () => saveDraft());
    $('#revert').addEventListener('click', () => { if (confirm('לשחזר את המסמך לגרסה שנקלטה? השינויים יימחקו.')) { d.editor_content = d.baseline_content; st.dirty = true; renderPanel2(); saveDraft(); } });
    const ed = $('#editor');
    if (ed) ed.addEventListener('input', () => { d.editor_content = ed.value; st.dirty = true; $('#save-status').textContent = 'יש שינויים שלא נשמרו'; clearTimeout(st.timer); st.timer = setTimeout(() => saveDraft(), 2500); });
  }
  const syncEditor = () => { const ed = $('#editor'); if (ed && st.doc) st.doc.editor_content = ed.value; };

  async function saveDraft() {
    syncEditor(); clearTimeout(st.timer);
    const d = st.doc, s = $('#save-status');
    if (!d || !st.dirty) { if (s) s.textContent = 'נשמר'; return; }
    if (s) s.textContent = 'שומר...';
    const sent = d.editor_content;
    const r = await L.fn('/api/v1/documents/draft', { document_id: d.id, content: sent });
    if (!r.json.ok) { if (s) s.innerHTML = `<span style="color:var(--red-text)">${esc(L.errorText(r))}</span>`; return; }
    if (r.json.changed) { d.editor_content = r.json.saved_text; const ed = $('#editor'); if (ed) ed.value = r.json.saved_text; if (s) s.textContent = 'נשמר. זוהה מידע מזהה בטקסט שהוקלד והוסתר.'; }
    else if (s) s.textContent = 'נשמר';
    st.dirty = d.editor_content !== sent ? false : false;
    const { data } = await L.safely(L.client.rpc('lalum_doc_signoff_status', { p_doc: d.id }));
    st.signoff = data || null; renderGate();
  }

  function insertClause(text) {
    st.mode = 'edit'; renderPanel2();
    const ed = $('#editor'), d = st.doc;
    const pos = ed.selectionStart != null && ed.selectionStart > 0 ? ed.selectionStart : ed.value.length;
    ed.value = ed.value.slice(0, pos) + (pos ? '\n\n' : '') + text + '\n\n' + ed.value.slice(pos);
    d.editor_content = ed.value; st.dirty = true; ed.focus();
    $('#save-status').textContent = 'הסעיף נוסף. בדקו את ההשלמות בסוגריים [__] ושמרו.';
    clearTimeout(st.timer); st.timer = setTimeout(() => saveDraft(), 2500);
  }

  function showHighlight(f) {
    const box = $('#hl-box'); if (!box) return;
    const legal = `<div class="ck-note"><b>בסיס משפטי:</b> ${f.citationUrl ? `<a href="${esc(f.citationUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:underline">${esc(f.citation || f.citationUrl)}</a>` : esc(f.citation || 'אין אסמכתה מוגדרת לכלל זה')}</div>`;
    box.innerHTML = `<div class="card" style="gap:6px"><div class="card-title">${esc(f.ruleName)}</div>${f.excerpt ? `<div class="ck-note">קטע בטקסט: <mark>${esc(f.excerpt)}</mark></div>` : '<div class="ck-note">הכלל מסמן היעדר סעיף, ולכן אין קטע להצגה.</div>'}${legal}
      ${f.span ? '<button class="ck-btn" id="jump">קפיצה לקטע בעורך</button>' : ''}</div>`;
    const j = $('#jump');
    if (j) j.addEventListener('click', () => {
      st.mode = 'edit'; renderPanel2();
      const ed = $('#editor'), needle = st.analyzedText.slice(f.span.start, f.span.end);
      let i = ed.value.indexOf(needle); if (i < 0) i = f.span.start;
      ed.focus(); ed.setSelectionRange(i, i + needle.length);
    });
    box.scrollIntoView({ block: 'nearest' });
  }

  // Panel 3: agent studio + sign-off gate
  function renderPanel3() {
    const p = $('#panel3'), r = st.risk;
    p.innerHTML = `<h2>אולפן סוכני תחום</h2>
      <label class="ck-field">פלייבוק מקצועי (PracticeAgentSelector)<select class="ck-select" id="agent">${Object.entries(L.PRACTICE).map(([k, v]) => `<option value="${k}"${k === st.area ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <div class="ck-row"><button class="ck-btn" id="reanalyze">ניתוח מחדש על הטקסט הנוכחי</button><span id="an-status" class="ck-note" aria-live="polite"></span></div>
      <div id="risk-matrix">${r ? `<div class="ck-row">${badge('RED')} <b>${r.red}</b> ${badge('YELLOW')} <b>${r.yellow}</b> ${badge('GREEN')} <b>${r.green}</b></div>
        <div class="bar-row"><span>ציון בטיחות</span><span>${r.score}/100</span></div><div class="bar-track"><div class="bar-fill" style="width:${r.score}%"></div></div>` : '<span class="ck-note">אין ניתוח</span>'}</div>
      <div class="ck-stack" id="findings">${st.findings.filter((f) => f.severity !== 'GREEN').map(findingHTML).join('') || '<span class="ck-note">לא נמצאו ממצאים בסיכון.</span>'}
        ${st.findings.some((f) => f.severity === 'GREEN') ? `<details><summary class="ck-note">כללים שהתקיימו (${st.findings.filter((f) => f.severity === 'GREEN').length})</summary><div class="ck-stack" style="margin-top:8px">${st.findings.filter((f) => f.severity === 'GREEN').map(findingHTML).join('')}</div></details>` : ''}</div>
      <div id="gate-slot"></div>`;
    $('#agent').addEventListener('change', reanalyze);
    $('#reanalyze').addEventListener('click', reanalyze);
    p.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('click', (e) => {
      const f = st.findings[Number(el.dataset.f)];
      if (e.target.closest('[data-cite]')) showHighlight(f); else if (e.target.closest('[data-insert]')) insertClause(f.fallbackClause);
    }));
    renderGate();
  }
  const findingHTML = (f) => { const i = st.findings.indexOf(f), sev = f.severity.toLowerCase(); return `<div class="finding ${sev}" data-f="${i}">
    <div class="ck-row">${badge(f.severity)}<b style="font-size:13.5px">${esc(f.ruleName)}</b></div><div class="ck-note">${esc(f.description)}</div>
    <div class="ck-row"><button class="link" data-cite>${esc(f.citation ? 'מקור: ' + f.citation : 'הצג מקור וקטע')}</button>${f.fallbackClause ? '<button class="ck-btn" data-insert>הוספת סעיף חלופי</button>' : ''}</div></div>`; };

  async function reanalyze() {
    syncEditor();
    const area = $('#agent').value, s = $('#an-status');
    s.textContent = 'מנתח...';
    const text = st.doc.editor_content;
    const r = await L.fn('/api/v1/documents/analyze', { text, practice_area: area });
    if (!r.json.ok) { s.innerHTML = `<span style="color:var(--red-text)">${esc(L.errorText(r))}</span>`; return; }
    st.area = area; st.findings = r.json.findings; st.risk = r.json.risk; st.analyzedText = text;
    renderPanel3();
  }

  function renderGate() {
    const slot = $('#gate-slot'); if (!slot) return;
    const so = st.signoff || { steps: {}, complete: false }, role = st.member.role;
    const ok = so.complete === true;
    slot.innerHTML = `<div class="gate${ok ? ' done' : ''}" role="group" aria-label="שער אישור אנושי (HumanSignOffGate)"><b>אישור אנושי חובה לפני ייצוא</b>
      ${STEPS.map(([k, t]) => { const s = so.steps && so.steps[k]; const valid = s && s.valid; const dis = !['FIRM_PARTNER', 'ATTORNEY'].includes(role) || (k === 'PARTNER_APPROVAL' && role !== 'FIRM_PARTNER');
        return `<label><input type="checkbox" data-step="${k}"${valid ? ' checked' : ''}${dis ? ' disabled' : ''}> ${esc(t)}${s && !s.valid ? ' <span class="stale">(בוטל: הטקסט שונה)</span>' : ''}${k === 'PARTNER_APPROVAL' && role !== 'FIRM_PARTNER' ? ' <span class="ck-note">(שותף בלבד)</span>' : ''}</label>`; }).join('')}
      <div id="gate-msg" aria-live="polite"></div>
      <label class="ck-note" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="restore"${st.originals.has(st.doc.id) ? ' checked' : ' disabled'}> שחזור פרטים מזהים בקובץ המיוצא (זמין רק בסשן שבו הועלה המקור)</label>
      <div class="ck-row"><button class="ck-btn primary" id="exp-word"${ok ? '' : ' disabled'}>ייצוא Word</button><button class="ck-btn primary" id="exp-pdf"${ok ? '' : ' disabled'}>ייצוא PDF</button></div>
      ${ok ? '' : '<div class="ck-note">הייצוא נחסם עד שכל ארבעת השלבים מסומנים על הטקסט הנוכחי.</div>'}</div>`;
    slot.querySelectorAll('[data-step]').forEach((c) => c.addEventListener('change', async () => {
      syncEditor(); if (st.dirty) await saveDraft();
      const fn = c.checked ? 'lalum_check_step' : 'lalum_uncheck_step';
      const { error } = await L.safely(L.client.rpc(fn, { p_doc: st.doc.id, p_step: c.dataset.step }));
      if (error) $('#gate-msg').innerHTML = `<div class="ck-err">${esc(error.message)}</div>`;
      const { data } = await L.safely(L.client.rpc('lalum_doc_signoff_status', { p_doc: st.doc.id }));
      st.signoff = data || null; renderGate();
    }));
    const doExport = async (kind) => {
      const r = await L.fn('/api/v1/documents/export', { document_id: st.doc.id });
      if (!r.json.ok) { $('#gate-msg').innerHTML = `<div class="ck-err">${esc(L.errorText(r))}</div>`; return; }
      let content = r.json.content; const map = tokenMap(st.doc.id);
      if (map && $('#restore').checked) content = restoreTokens(content, map);
      const html = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>${esc(r.json.file_name)}</title><style>body{font-family:David,'Times New Roman',serif;font-size:13pt;line-height:1.8;direction:rtl;white-space:pre-wrap}</style></head><body>${esc(content)}</body></html>`;
      if (kind === 'word') {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }));
        a.download = (r.json.file_name.replace(/\.[^.]+$/, '') || 'document') + '.doc'; document.body.appendChild(a); a.click(); a.remove();
      } else {
        const w = window.open('', '_blank'); if (!w) { $('#gate-msg').innerHTML = '<div class="ck-err">הדפדפן חסם את חלון ההדפסה.</div>'; return; }
        w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
      }
    };
    $('#exp-word').addEventListener('click', () => doExport('word'));
    $('#exp-pdf').addEventListener('click', () => doExport('pdf'));
  }

  // PII Inspector drawer: masked tokens vs original (original exists only in this browser session)
  function openPiiDrawer() {
    const dr = $('#pii-drawer'), d = st.doc, map = d ? tokenMap(d.id) : null;
    syncEditor();
    const tokens = d ? [...new Set(d.editor_content.match(/\[[A-Z_]+_\d+\]/g) || [])] : [];
    let showOrig = false;
    const draw = () => {
      dr.innerHTML = `<div class="card-row"><h2 class="display" style="font-size:17px">בודק PII</h2><button class="ck-btn" id="pii-close" aria-label="סגירה">סגירה</button></div>
        <div class="ck-note">${map ? 'המקור זמין בזיכרון הדפדפן בלבד, מהסשן שבו הועלה המסמך. הוא לא נשמר בשרת וייעלם ברענון.' : 'מיפוי הזהויות נמחק בהתאם ל-Zero Data Retention ואינו זמין בשרת. ניתן לראות את המקור רק בסשן שבו הועלה המסמך.'}</div>
        <div class="ck-row"><button class="ck-btn${showOrig ? '' : ' primary'}" id="pii-masked">מוסתר</button><button class="ck-btn${showOrig ? ' primary' : ''}" id="pii-orig"${map ? '' : ' disabled'}>מקור</button></div>
        <div class="ck-table-wrap"><table class="ck-table"><thead><tr><th>אסימון</th><th>סוג</th><th>ערך</th></tr></thead><tbody>${tokens.map((t) => `<tr><td dir="ltr">${esc(t)}</td><td>${esc(KIND_HE[tokenKind(t)] || '')}</td><td>${showOrig && map && map.has(t) ? esc(map.get(t)) : '••••••'}</td></tr>`).join('') || '<tr><td colspan="3">אין אסימונים</td></tr>'}</tbody></table></div>
        <div class="section-label">המסמך</div><div class="editor" style="min-height:120px;max-height:40vh;overflow:auto">${esc(d ? (showOrig && map ? restoreTokens(d.editor_content, map) : d.editor_content) : '')}</div>`;
      $('#pii-close').addEventListener('click', () => { dr.hidden = true; });
      $('#pii-masked').addEventListener('click', () => { showOrig = false; draw(); });
      $('#pii-orig').addEventListener('click', () => { showOrig = true; draw(); });
    };
    draw(); dr.hidden = false; $('#pii-close').focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const dr = $('#pii-drawer'); if (dr) dr.hidden = true; } });

  // ---------- boot ----------
  (async function () {
    const ctx = await L.boot(root, { prompt: 'נדרשת התחברות כדי לפתוח את הקוקפיט.' });
    if (!ctx) return;
    st.member = ctx.member;
    const id = new URLSearchParams(location.search).get('matter') || (location.pathname.match(/\/workspace\/([0-9a-f-]{36})/) || [])[1];
    if (id) openMatter(id); else renderList();
  })();
})();
