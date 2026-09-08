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

  // Never fail silently: if the Supabase library or config didn't load
  // (CDN hiccup, offline, ad-blocker), say so instead of leaving the
  // screen blank.
  if (!window.supabase || !window.LALUM_SUPABASE_URL) {
    const msg = '<div class="card"><div class="card-meta">לא ניתן היה לטעון את שירות הנתונים (בעיית רשת). רעננו את הדף ונסו שוב.</div></div>';
    clientsGate.innerHTML = msg;
    communityGate.innerHTML = msg;
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

  function authGateHTML(promptText) {
    return `
      <div class="card" style="gap:12px;">
        <div class="card-meta">${escapeHTML(promptText)}</div>
        <form class="auth-form" style="display:flex; gap:8px;">
          <input type="email" required placeholder="האימייל שלך" class="auth-email"
            style="flex:1; background:var(--surface-raised); border:1px solid var(--border); border-radius:10px; padding:0 12px; height:40px; color:var(--text); font-family:inherit; font-size:13px;">
          <button type="submit" class="btn-primary" style="width:auto; height:40px; padding:0 16px;">שליחת לינק כניסה</button>
        </form>
        <div class="auth-status card-meta" style="font-size:12px;"></div>
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
      status.textContent = 'שולח...';
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      status.textContent = error ? ('שגיאה: ' + error.message) : 'לינק כניסה נשלח — בדקו את המייל';
    });
  }

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
    clientsList.innerHTML = data.map((c) => `
      <div class="card">
        <div class="card-row">
          <span class="card-title">${escapeHTML(c.full_name || 'ללא שם')}</span>
          ${c.is_lead ? '<span class="pill pill-amber">ליד</span>' : '<span class="pill pill-green">לקוח</span>'}
        </div>
        <span class="card-meta">${escapeHTML(c.phone || '')} · ${timeAgo(c.created_at)}</span>
      </div>`).join('');
  }

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
