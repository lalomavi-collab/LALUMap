// Real-data layer: Supabase Auth (magic link) + two RLS-gated tables.
// lalum_contacts is admin-only (lalum_is_admin()); lalum_group_chat_messages
// requires any signed-in session. Unauthenticated visitors see a sign-in
// prompt, never fabricated placeholder rows — what renders is exactly what
// the current session is allowed to read.

(function () {
  const clientsGate = document.getElementById('clients-auth-gate');
  const clientsList = document.getElementById('clients-list');
  const communityGate = document.getElementById('community-auth-gate');
  const communityList = document.getElementById('community-list');
  const communityComposer = document.getElementById('community-composer');
  const communityInput = document.getElementById('community-input');
  const newClientToggle = document.getElementById('new-client-toggle');
  const newClientCard = document.getElementById('new-client-form-card');
  const newClientForm = document.getElementById('new-client-form');
  const newClientCancel = document.getElementById('new-client-cancel');
  const newClientStatus = document.getElementById('new-client-status');

  // Never fail silently: if the Supabase library or config didn't load
  // (CDN hiccup, offline, ad-blocker), say so instead of leaving the
  // screen blank.
  if (!window.supabase || !window.LALUM_SUPABASE_URL) {
    const msg = '<div class="card"><div class="card-meta">לא ניתן היה לטעון את שירות הנתונים (בעיית רשת). רעננו את הדף ונסו שוב.</div></div>';
    clientsGate.innerHTML = msg;
    communityGate.innerHTML = msg;
    const newsletterCard = document.getElementById('newsletter-card');
    if (newsletterCard) newsletterCard.innerHTML = msg;
    return;
  }

  const client = window.supabase.createClient(window.LALUM_SUPABASE_URL, window.LALUM_SUPABASE_ANON_KEY);

  function escapeHTML(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function timeAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'עכשיו';
    if (mins < 60) return `לפני ${mins} דק'`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `לפני ${hrs} שע'`;
    return `לפני ${Math.round(hrs / 24)} ימים`;
  }

  // Outlined pill field + a checkmark success banner (once the link is sent),
  // matching the labelled-field / success-state pattern of the app's own
  // reference direction, instead of a plain status line.
  function authGateHTML(promptText) {
    return `
      <div class="card" style="gap:14px;">
        <div class="card-meta">${escapeHTML(promptText)}</div>
        <form class="auth-form" style="display:flex; flex-direction:column; gap:10px;">
          <input type="email" required placeholder="האימייל שלך" aria-label="האימייל שלך" class="auth-email"
            style="background:var(--surface); border:1px solid var(--border-strong); border-radius:9999px; padding:0 18px; height:44px; color:var(--text); font-family:inherit; font-size:14px;">
          <button type="submit" class="btn-primary" style="height:44px;">שליחת לינק כניסה</button>
        </form>
        <div class="auth-status" aria-live="polite"></div>
      </div>`;
  }

  function authStatusHTML(kind, text) {
    if (kind === 'sending') return `<span class="card-meta" style="font-size:12px;">${escapeHTML(text)}</span>`;
    if (kind === 'error') return `<span class="card-meta" style="font-size:12px; color:var(--red);">${escapeHTML(text)}</span>`;
    // 'ok': a small check-in-a-circle banner, same visual language as the
    // ok-tone check icon in the ביקורת AI cards.
    return `
      <div style="display:flex; align-items:center; gap:8px; background:var(--green-bg); border-radius:9999px; padding:8px 14px;">
        <span style="width:20px;height:20px;border-radius:50%;background:var(--green);display:flex;align-items:center;justify-content:center;flex-shrink:0;" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M20 6L9 17l-5-5"/></svg>
        </span>
        <span class="card-meta" style="font-size:12.5px; color:var(--text); font-weight:600;">${escapeHTML(text)}</span>
      </div>`;
  }

  function wireAuthForm(container) {
    const form = container.querySelector('.auth-form');
    if (!form) return;
    const status = container.querySelector('.auth-status');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.querySelector('.auth-email').value.trim();
      if (!email) return;
      status.innerHTML = authStatusHTML('sending', 'שולח...');
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      status.innerHTML = error
        ? authStatusHTML('error', 'שגיאה: ' + error.message)
        : authStatusHTML('ok', 'לינק כניסה נשלח — בדקו את המייל');
    });
  }

  // ניוזלטר יומי — public signup via lalum-newsletter-subscribe (no auth
  // required; consent text is shown and stored verbatim, per Privacy Law
  // Amendment 13). Reuses the same pill-input / checkmark-success pattern
  // as authGateHTML/authStatusHTML above.
  const NEWSLETTER_CONSENT_VERSION = 'v1-2026-09';
  const NEWSLETTER_CONSENT_TEXT = 'בהרשמה אני מאשר/ת קבלת עדכון קצר מ-LALUM מדי יום. ניתן להסיר בכל עת בלחיצה אחת בתחתית כל מייל.';

  function newsletterCardHTML() {
    return `
      <div class="card" style="gap:14px;">
        <div class="section-label">עדכון יומי</div>
        <div class="card-title">תובנה משפטית קצרה כל בוקר</div>
        <div class="card-meta">${escapeHTML(NEWSLETTER_CONSENT_TEXT)}</div>
        <form class="newsletter-form" style="display:flex; flex-direction:column; gap:10px;">
          <input type="email" required placeholder="האימייל שלך" aria-label="האימייל שלך" class="newsletter-email"
            style="background:var(--surface); border:1px solid var(--border-strong); border-radius:9999px; padding:0 18px; height:44px; color:var(--text); font-family:inherit; font-size:14px;">
          <button type="submit" class="btn-primary" style="height:44px;">הרשמה לעדכון היומי</button>
        </form>
        <div class="newsletter-status" aria-live="polite"></div>
      </div>`;
  }

  function wireNewsletterForm() {
    const container = document.getElementById('newsletter-card');
    if (!container) return;
    container.innerHTML = newsletterCardHTML();
    const form = container.querySelector('.newsletter-form');
    const status = container.querySelector('.newsletter-status');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.querySelector('.newsletter-email').value.trim();
      if (!email) return;
      status.innerHTML = authStatusHTML('sending', 'נרשמים...');
      const { error } = await client.functions.invoke('lalum-newsletter-subscribe', {
        body: {
          email,
          source: 'lalumap',
          consent_text_version: NEWSLETTER_CONSENT_VERSION,
          consent_text: NEWSLETTER_CONSENT_TEXT,
        },
      });
      status.innerHTML = error
        ? authStatusHTML('error', 'שגיאה בהרשמה — נסו שוב')
        : authStatusHTML('ok', 'נרשמתם! העדכון הבא יגיע במייל');
      if (!error) form.reset();
    });
  }

  wireNewsletterForm();

  // "לקוח חדש": a real INSERT into lalum_contacts, protected by the
  // admin_insert_contacts RLS policy (mirrors admin_read_contacts — only
  // lalum_is_admin() can write). A non-admin session that somehow reaches
  // this form still gets rejected at the database itself, not just hidden
  // by the UI; the button is only ever shown to a session that already
  // passed the read-side admin check by virtue of seeing the client list.
  function closeNewClientForm() {
    newClientCard.hidden = true;
    newClientToggle.setAttribute('aria-expanded', 'false');
    newClientForm.reset();
    newClientStatus.innerHTML = '';
  }

  function wireNewClientForm() {
    if (!newClientToggle || !newClientForm) return;

    newClientToggle.addEventListener('click', () => {
      const opening = newClientCard.hidden;
      newClientCard.hidden = !opening;
      newClientToggle.setAttribute('aria-expanded', String(opening));
      if (opening) document.getElementById('new-client-name').focus();
      else { newClientForm.reset(); newClientStatus.innerHTML = ''; }
    });

    newClientCancel.addEventListener('click', closeNewClientForm);

    newClientForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const full_name = document.getElementById('new-client-name').value.trim();
      const phone = document.getElementById('new-client-phone').value.trim();
      const is_lead = newClientForm.querySelector('input[name="new-client-kind"]:checked').value === 'lead';
      if (!full_name || !phone) return;

      const submitBtn = newClientForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      newClientStatus.innerHTML = authStatusHTML('sending', 'שומר...');

      const { error } = await client.from('lalum_contacts').insert({ full_name, phone, is_lead });

      submitBtn.disabled = false;
      if (error) {
        // 23505: unique_violation — this table's own `phone` column is
        // declared unique, so a repeat number is the one error worth a
        // specific message; everything else surfaces the raw reason
        // (RLS denial included) rather than guessing at one.
        const message = error.code === '23505'
          ? 'מספר הטלפון הזה כבר קיים במערכת.'
          : `שגיאה בשמירה: ${error.message}`;
        newClientStatus.innerHTML = authStatusHTML('error', message);
        return;
      }

      closeNewClientForm();
      loadClients(currentSession);
    });
  }

  wireNewClientForm();

  async function loadClients(session) {
    if (!session) {
      clientsGate.innerHTML = authGateHTML('נדרשת התחברות כמנהל/ת כדי לצפות ברשימת הלקוחות האמיתית.');
      wireAuthForm(clientsGate);
      clientsList.innerHTML = '';
      return;
    }
    clientsGate.innerHTML = '';
    clientsList.innerHTML = '<div class="card-meta">טוען...</div>';
    const { data, error } = await client
      .from('lalum_contacts')
      .select('full_name, phone, is_lead, created_at')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      clientsList.innerHTML = `<div class="card"><div class="card-meta">אין הרשאת מנהל/ת לצפייה ברשימת הלקוחות (${escapeHTML(error.message)})</div></div>`;
      return;
    }
    if (!data || data.length === 0) {
      clientsList.innerHTML = '<div class="card"><div class="card-meta">אין לקוחות להצגה, או שאין הרשאת מנהל/ת לחשבון זה.</div></div>';
      return;
    }
    clientsList.innerHTML = data.map((c, i) => `
      <div class="card">
        <div class="card-row">
          <span class="card-title">${escapeHTML(c.full_name || 'ללא שם')}</span>
          ${c.is_lead ? '<span class="pill pill-amber">ליד</span>' : '<span class="pill pill-green">לקוח</span>'}
        </div>
        <span class="card-meta">${escapeHTML(c.phone || '')} · ${timeAgo(c.created_at)}</span>
        <button type="button" class="vault-toggle" data-vault="${i}" aria-expanded="false" aria-controls="vault-body-${i}" style="display:flex; align-items:center; gap:6px; background:none; border:none; padding:4px 0 0; color:var(--text-secondary); font-size:12.5px; font-weight:600; width:fit-content;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
          תיק מסמכים
          <svg class="vault-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition:transform .15s ease;" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <div class="vault-body" id="vault-body-${i}" data-vault-body="${i}">
          ${matterVaultHTML(i)}
        </div>
      </div>`).join('');
  }

  // "תיק מסמכים" — a per-client document vault preview. Deliberately static:
  // there is no documents/attachments schema behind lalum_contacts yet, so
  // this shows what the feature would look like without fabricating real
  // records against a real client's name.
  const VAULT_DOCS = [
    { name: 'הסכם שכר טרחה', tone: 'green', label: 'נחתם' },
    { name: 'ייפוי כוח', tone: 'amber', label: 'ממתין לחתימה' },
    { name: 'תעודת זהות (סרוקה)', tone: 'green', label: 'נסרק' },
    { name: 'טיוטת הסכם', tone: 'neutral', label: 'בעיבוד' },
  ];
  function matterVaultHTML(seed) {
    const rows = VAULT_DOCS.map((d) => `
      <div class="card-row" style="gap:8px;">
        <span style="display:flex; align-items:center; gap:8px; font-size:13px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
          ${escapeHTML(d.name)}
        </span>
        <span class="pill pill-${d.tone}">${d.label}</span>
      </div>`).join('');
    return rows + '<span class="card-meta" style="font-size:11px; font-style:italic;">תצוגה לדוגמה — טרם מחובר למסמכים אמיתיים</span>';
  }

  clientsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.vault-toggle');
    if (!btn) return;
    const body = clientsList.querySelector(`[data-vault-body="${btn.dataset.vault}"]`);
    if (!body) return;
    const open = body.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('.vault-chevron').style.transform = open ? 'rotate(180deg)' : 'none';
  });

  async function loadCommunity(session) {
    if (!session) {
      communityGate.innerHTML = authGateHTML('התחברו כדי לראות ולהשתתף בקהילת LALUM.');
      wireAuthForm(communityGate);
      communityComposer.style.display = 'none';
      communityList.innerHTML = '';
      return;
    }
    communityGate.innerHTML = '';
    communityComposer.style.display = 'flex';
    communityList.innerHTML = '<div class="card-meta">טוען...</div>';
    const { data, error } = await client
      .from('lalum_group_chat_messages')
      .select('author_name, body, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      communityList.innerHTML = `<div class="card"><div class="card-meta">שגיאה בטעינת הקהילה (${escapeHTML(error.message)})</div></div>`;
      return;
    }
    if (!data || data.length === 0) {
      communityList.innerHTML = '<div class="card"><div class="card-meta">עדיין אין הודעות — היו הראשונים לכתוב.</div></div>';
      return;
    }
    communityList.innerHTML = data.map((m) => `
      <div class="card">
        <div class="card-row"><span class="card-title">${escapeHTML(m.author_name || 'חבר/ת קהילה')}</span><span class="card-meta">${timeAgo(m.created_at)}</span></div>
        <span class="card-meta">${escapeHTML(m.body)}</span>
      </div>`).join('');
  }

  communityComposer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data: { session } } = await client.auth.getSession();
    if (!session) return;
    const body = communityInput.value.trim();
    if (!body) return;
    const { error } = await client.from('lalum_group_chat_messages').insert({
      user_id: session.user.id,
      author_name: session.user.email || 'חבר/ת קהילה',
      body,
    });
    if (!error) {
      communityInput.value = '';
      loadCommunity(session);
    }
  });

  let currentSession = null;

  client.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    loadClients(session);
    loadCommunity(session);
  });

  document.addEventListener('lalum:screenchange', (e) => {
    if (e.detail.name === 'practice') loadClients(currentSession);
    if (e.detail.name === 'community') loadCommunity(currentSession);
  });

  client.auth.getSession().then(({ data: { session } }) => {
    currentSession = session;
    loadClients(session);
    loadCommunity(session);
  });
})();
