// Shared helpers for the standalone cockpit pages (workspace, admin, billing).
// Same Supabase project and session as the main app (same origin, same storage key).
(function () {
  const L = (window.LalumCommon = {});
  L.ready = !!(window.supabase && window.LALUM_SUPABASE_URL);
  L.client = L.ready ? window.supabase.createClient(window.LALUM_SUPABASE_URL, window.LALUM_SUPABASE_ANON_KEY) : null;

  L.esc = function (s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML.replace(/"/g, '&quot;');
  };

  // A rejected network promise must never leave a spinner on screen.
  L.safely = async function (p) {
    try { return await p; } catch (e) { return { data: null, error: { message: 'שגיאת רשת. בדקו את החיבור ונסו שוב.', code: 'network_error' } }; }
  };

  L.PRACTICE = { REAL_ESTATE: 'נדל"ן / תמ"א 38', COMMERCIAL_MA: 'מסחרי / M&A', LABOR_LAW: 'דיני עבודה', AI_GOVERNANCE: 'ממשל AI', LITIGATION: 'ליטיגציה' };
  L.RESPONSE = { PENDING_REVIEW: 'ממתין לבדיקה', ACCEPTED: 'התקבל', DECLINED: 'נדחה', CLIENT_CONTACTED: 'נוצר קשר עם הלקוח' };
  L.CONFLICT = { CLEAN: ['green', 'נקי'], POTENTIAL: ['yellow', 'בדיקה ידנית'], DIRECT_CONFLICT: ['red', 'ניגוד ישיר'] };
  L.MATTER_STATUS = { INTAKE_PENDING: 'ממתין לקליטה', ACTIVE_REVIEW: 'בבדיקה פעילה', APPROVED_BY_PARTNER: 'אושר על ידי שותף', ARCHIVED: 'בארכיון' };
  L.ROLE = { FIRM_PARTNER: 'שותף במשרד', ATTORNEY: 'עורך דין', COMPLIANCE_OFFICER: 'ממונה ציות', ADMIN: 'מנהל משרד' };

  L.fmt = (iso) => (iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');

  L.nav = function (active) {
    const items = [['/workspace/', 'תיקים', 'workspace'], ['/admin/matters.html', 'ניהול', 'admin'], ['/settings/billing.html', 'חיוב והגדרות', 'billing'], ['/guide.html', 'מדריך', 'guide'], ['/', 'לאפליקציה', 'home']];
    return '<nav class="ck-nav" aria-label="ניווט ראשי">' + items.map(([h, t, k]) => `<a href="${h}"${k === active ? ' aria-current="page"' : ''}>${t}</a>`).join('') + '</nav>';
  };

  L.gate = function (root, text) {
    root.innerHTML = `<div class="card" style="gap:14px;max-width:420px;margin:40px auto;">
      <div class="card-meta">${L.esc(text)}</div>
      <form class="ck-stack" id="ck-login"><input class="ck-input" type="email" required placeholder="האימייל שלך" aria-label="האימייל שלך" autocomplete="email">
      <button class="ck-btn primary" type="submit">שליחת לינק כניסה</button></form><div id="ck-login-status" aria-live="polite"></div></div>`;
    root.querySelector('#ck-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = root.querySelector('#ck-login-status');
      st.innerHTML = '<span class="ck-note">שולח...</span>';
      const { error } = await L.safely(L.client.auth.signInWithOtp({ email: e.target.querySelector('input').value.trim(), options: { emailRedirectTo: location.href } }));
      st.innerHTML = error ? `<div class="ck-err">${L.esc(error.message)}</div>` : '<div class="ck-ok">שלחנו לינק כניסה למייל.</div>';
    });
  };

  // Resolves { session, firm, member } or renders the right empty state into root and resolves null.
  L.boot = async function (root, opts) {
    if (!L.ready) { root.innerHTML = '<div class="ck-err">לא ניתן לטעון את שירות הנתונים (בעיית רשת). רעננו את הדף.</div>'; return null; }
    const { data } = await L.safely(L.client.auth.getSession());
    const session = data && data.session;
    if (!session) { L.gate(root, (opts && opts.prompt) || 'נדרשת התחברות.'); return null; }
    L.session = session;
    const [{ data: member }, { data: isAdmin }] = await Promise.all([
      L.safely(L.client.from('lalum_firm_members').select('firm_id, name, role, lalum_firms(firm_name, status, subscription_tier, monthly_fee, seat_limit)').eq('user_id', session.user.id).maybeSingle()),
      L.safely(L.client.rpc('lalum_is_admin')),
    ]);
    L.member = member || null;
    L.platformAdmin = isAdmin === true;
    if (!member && !(opts && opts.allowPlatformAdmin && L.platformAdmin)) {
      root.innerHTML = '<div class="card" style="max-width:520px;margin:40px auto;"><div class="card-title">החשבון אינו משויך למשרד</div><div class="card-meta">כדי להשתמש בקוקפיט יש לצרף את החשבון למשרד. פנו למנהל המערכת של LALUM.</div></div>';
      return null;
    }
    return { session, member, platformAdmin: L.platformAdmin };
  };

  L.fn = async function (path, body) {
    const { data } = await L.client.auth.getSession();
    const token = data && data.session ? data.session.access_token : '';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 55000);
    try {
      const res = await fetch(window.LALUM_SUPABASE_URL + '/functions/v1/lalum-pipeline' + path, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, apikey: window.LALUM_SUPABASE_ANON_KEY },
        body: JSON.stringify(body),
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* non-JSON error page */ }
      return { status: res.status, json: json || { ok: false, code: 'BAD_RESPONSE' } };
    } catch (e) {
      return { status: 0, json: { ok: false, code: 'NETWORK' } };
    } finally { clearTimeout(t); }
  };

  L.errorText = function (r) {
    const c = r.json && r.json.code;
    const map = {
      CONFLICT_HALT: (r.json && r.json.message) || 'בשל כללי האתיקה ומניעת ניגוד עניינים, נמנע מאיתנו לקבל את הטיפול בפנייה.',
      PII_LEAK_BLOCKED: 'הטקסט נחסם: זוהה מידע מזהה שלא ניתן היה להסתיר. הסירו אותו ונסו שוב.',
      FIRM_INACTIVE: 'מנוי המשרד אינו פעיל.', TOO_LARGE: 'הטקסט גדול מדי.', EMPTY_INPUT: 'לא הוזן טקסט.',
      UNAUTHENTICATED: 'פג תוקף ההתחברות. התחברו מחדש.', SIGN_OFF_REQUIRED: 'הייצוא חסום עד להשלמת ארבעת שלבי האישור על הטקסט הנוכחי.',
      PIPELINE_UNAVAILABLE: 'השירות אינו זמין כרגע. לא נשלח דבר לגורם חיצוני. נסו שוב.', NETWORK: 'שגיאת רשת. נסו שוב.', LLM_UNAVAILABLE: 'שירות ה-AI אינו זמין כרגע.',
    };
    return map[c] || 'הפעולה נכשלה. נסו שוב.';
  };
})();
