// Admin overseer: matters table with filters and live SLA, plus the conflict check audit log.
// Reads lalum_v_admin_matters (metadata only: no document content). RLS decides who sees what:
// a platform admin sees every firm, a firm partner / admin / compliance officer sees their own firm.
(function () {
  const L = window.LalumCommon, esc = L.esc;
  const root = document.getElementById('ck-root');
  document.getElementById('ck-nav').innerHTML = L.nav('admin');
  const SLA_MIN = 120;
  let rows = [], checks = [], firms = [], filters = { firm: '', area: '', resp: '' }, tick = null;
  const REASON = { ADVERSE_IS_ACTIVE_CLIENT: 'הצד שכנגד הוא לקוח פעיל', CLIENT_IS_ACTIVE_ADVERSE: 'הלקוח הוא צד שכנגד בתיק פעיל', OPPOSING_HISTORICAL_MATTER: 'התנגשות מול תיק היסטורי', ROLE_UNKNOWN_MATCH: 'התאמה עם תפקיד לא ידוע', PARTIAL_NAME_MATCH_OPPOSING: 'התאמת שם חלקית מול צד מנוגד' };

  const minutes = (r) => (r.first_viewed_at || r.partner_response !== 'PENDING_REVIEW' ? null : Math.floor((Date.now() - new Date(r.dispatched_at).getTime()) / 60000));
  const slaCell = (r) => {
    const m = minutes(r);
    if (m == null) return '<span class="ck-badge green">טופל</span>';
    const h = Math.floor(m / 60), txt = h ? `${h} שע' ${m % 60} דק'` : `${m} דק'`;
    return m > SLA_MIN ? `<span class="ck-badge red" title="חריגה מ-2 שעות">⚠ ${txt}</span>` : `<span class="ck-badge yellow">${txt}</span>`;
  };

  function filtered() {
    return rows.filter((r) => (!filters.firm || r.firm_id === filters.firm) && (!filters.area || r.practice_area === filters.area) && (!filters.resp || r.partner_response === filters.resp));
  }

  function drawTable() {
    const f = filtered(), breached = f.filter((r) => (minutes(r) || 0) > SLA_MIN).length;
    document.getElementById('tbl').innerHTML = `
      <div class="ck-row"><span class="ck-badge ${breached ? 'red' : 'green'}">${breached ? `${breached} תיקים חורגים מ-SLA (מעל שעתיים ללא צפייה)` : 'אין חריגות SLA'}</span><span class="ck-note">${f.length} תיקים · מתעדכן אוטומטית</span></div>
      <div class="ck-table-wrap"><table class="ck-table"><thead><tr><th>משרד</th><th>תיק</th><th>תחום</th><th>ניגוד</th><th>תגובת שותף</th><th>נקלט</th><th>ממתין</th></tr></thead><tbody>
      ${f.map((r) => `<tr class="${(minutes(r) || 0) > SLA_MIN ? 'sla-breach' : ''}"><td>${esc(r.firm_name)}</td><td>${esc(r.title)}</td><td>${esc(L.PRACTICE[r.practice_area] || '')}</td><td>${(([t, l]) => `<span class="ck-badge ${t}">${esc(l)}</span>`)(L.CONFLICT[r.conflict_status] || ['yellow', r.conflict_status])}</td><td>${esc(L.RESPONSE[r.partner_response] || '')}</td><td>${esc(L.fmt(r.dispatched_at))}</td><td>${slaCell(r)}</td></tr>`).join('') || '<tr><td colspan="7">אין תיקים להצגה</td></tr>'}
      </tbody></table></div>`;
  }

  function drawChecks() {
    const firmName = (id) => (firms.find((x) => x.id === id) || {}).firm_name || '';
    document.getElementById('audit').innerHTML = `<div class="ck-table-wrap"><table class="ck-table"><thead><tr><th>מועד</th><th>משרד</th><th>תוצאה</th><th>סיבות</th><th>התאמות</th><th>ישויות</th><th>מקור</th></tr></thead><tbody>
      ${checks.map((c) => `<tr><td>${esc(L.fmt(c.created_at))}</td><td>${esc(firmName(c.firm_id))}</td><td>${(([t, l]) => `<span class="ck-badge ${t}">${esc(l)}</span>`)(L.CONFLICT[c.status] || ['yellow', c.status])}</td><td>${esc((c.reason_codes || []).map((x) => REASON[x] || x).join(', ') || '-')}</td><td>${esc(c.match_count)}</td><td>${esc(c.entity_count)}</td><td>${esc(c.source)}</td></tr>`).join('') || '<tr><td colspan="7">אין רשומות. (יומן זה מוצג רק לשותף, ממונה ציות, מנהל משרד ולמנהל הפלטפורמה.)</td></tr>'}
      </tbody></table></div>
      <p class="ck-note">היומן אינו מכיל שמות או מספרי זהות, רק סטטוס, קודי סיבה ומספרים. מי שנדחה בשל ניגוד עניינים לא מקבל אף פרט מהיומן.</p>`;
  }

  async function verifyChains() {
    const out = document.getElementById('chain-out'); out.textContent = 'בודק...';
    const res = [];
    for (const f of firms) {
      const { data, error } = await L.safely(L.client.rpc('lalum_verify_audit_chain', { p_firm: f.id }));
      res.push(`${f.firm_name}: ${error ? 'שגיאה' : data === null ? 'שרשרת תקינה' : 'נשבר ברשומה ' + data}`);
    }
    out.innerHTML = res.map(esc).join('<br>') || 'אין משרדים';
  }

  async function load() {
    const [a, b, c] = await Promise.all([
      L.safely(L.client.from('lalum_v_admin_matters').select('*').order('dispatched_at', { ascending: false }).limit(500)),
      L.safely(L.client.from('lalum_conflict_checks').select('*').order('created_at', { ascending: false }).limit(200)),
      L.safely(L.client.from('lalum_firms').select('id, firm_name')),
    ]);
    rows = a.data || []; checks = b.data || []; firms = c.data || [];
    return !a.error;
  }

  async function start() {
    const ctx = await L.boot(root, { prompt: 'נדרשת התחברות כמנהל.', allowPlatformAdmin: true });
    if (!ctx) return;
    const ok = await load();
    if (!ok) { root.innerHTML = '<div class="ck-err">אין הרשאה לצפות בנתוני הניהול.</div>'; return; }
    const sel = (id, label, opts) => `<label class="ck-field">${label}<select class="ck-select" id="${id}"><option value="">הכול</option>${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
    root.innerHTML = `<div class="ck-grid2">${sel('f-firm', 'משרד', firms.map((f) => [f.id, f.firm_name]))}${sel('f-area', 'תחום', Object.entries(L.PRACTICE))}${sel('f-resp', 'סטטוס תגובה', Object.entries(L.RESPONSE))}</div>
      <div id="tbl" aria-live="polite"></div>
      <div class="section-label">יומן ביקורת ניגוד עניינים</div><div id="audit"></div>
      <div class="ck-row"><button class="ck-btn" id="verify">אימות שרשרת הביקורת הקריפטוגרפית</button></div><div id="chain-out" class="ck-note" aria-live="polite"></div>`;
    for (const [id, k] of [['f-firm', 'firm'], ['f-area', 'area'], ['f-resp', 'resp']]) document.getElementById(id).addEventListener('change', (e) => { filters[k] = e.target.value; drawTable(); });
    document.getElementById('verify').addEventListener('click', verifyChains);
    drawTable(); drawChecks();
    // live: refresh on any change to routings, and re-evaluate SLA timers every 30s
    L.client.channel('lalum-admin').on('postgres_changes', { event: '*', schema: 'public', table: 'lalum_intake_routings' }, async () => { await load(); drawTable(); drawChecks(); }).subscribe();
    tick = setInterval(drawTable, 30000);
    window.addEventListener('pagehide', () => clearInterval(tick));
  }
  start();
})();
