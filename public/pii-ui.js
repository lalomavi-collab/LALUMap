// LALUM PII Shield: in-app state, status badges, inspector drawer and audit
// logging. The masking engine itself is pii-shield.js (no DOM, unit-tested).
//
// One vault per page load (= one LEX conversation, since the transcript is
// itself page-load scoped, see lex.js). It is NOT purged after every
// request: the conversation history sent back to the model on each turn is
// masked, so the reply to turn 3 can mention [CLIENT_NAME_1] from turn 1,
// and unmasking it needs the same vault. It is purged on pagehide, which is
// the end of that conversation.

(function () {
  const PII = window.LalumPII;
  if (!PII) return;

  let vault = null;
  let lastExchange = null; // { original, masked, maskedReply, restoredReply, entities, count, at }

  function storage(kind) {
    try { return window[kind]; } catch { return null; }
  }

  function settings() {
    try { return PII.loadSettings(storage('localStorage'), storage('sessionStorage')); } catch { return { ...PII.DEFAULT_SETTINGS }; }
  }

  function getVault() {
    if (!vault || vault.purged) vault = PII.createVault();
    return vault;
  }

  // Throws if the shield is on but can't run (no WebCrypto, e.g. a non-HTTPS
  // origin): the caller must then NOT send. Fail closed, never fall back to
  // sending the plain text.
  async function maskOutgoing(text) {
    const s = settings();
    if (!s.enabled) return { masked: text, entities: [], count: 0, enabled: false };
    const r = await PII.mask(text, getVault(), s);
    return { ...r, enabled: true };
  }

  async function unmaskIncoming(text) {
    if (!vault) return text;
    return PII.unmask(text, vault);
  }

  function recordExchange(x) {
    lastExchange = { ...x, at: new Date() };
    renderBadges();
    if (drawer && !drawer.hidden) renderDrawer();
  }

  // Compliance trail: counts only, never the text, the tokens or the
  // originals. Signed-in users only (RLS requires it); an anonymous visitor's
  // turn is still masked, just not logged. Failures are swallowed: the audit
  // log must never block the attorney's work, and the masking already
  // happened regardless.
  async function audit(client, { surface, matterId, count, entities, enabled }) {
    if (!client) return;
    try {
      const { data } = await client.auth.getSession();
      if (!data || !data.session) return;
      await client.from('lalum_pii_audit_log').insert({
        surface: surface,
        matter_id: matterId || null,
        tokens_masked_count: count,
        entity_counts: PII.countByCategory(entities || []),
        pii_shield_enabled: !!enabled,
      });
    } catch { /* see comment above */ }
  }

  window.addEventListener('pagehide', () => {
    if (vault) vault.purge();
    vault = null;
    lastExchange = null;
  });

  // ---- Badges -----------------------------------------------------------

  const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const UNLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';
  const SHIELD_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M12 8v4M12 16h.01"/></svg>';

  function badgeState() {
    const s = settings();
    if (!s.enabled) return { tone: 'off', icon: UNLOCK_SVG, text: 'PII Shield כבוי', title: 'התממה אוטומטית כבויה. טקסט נשלח למנוע ה-AI כפי שהוקלד.' };
    const n = lastExchange ? lastExchange.count : 0;
    if (n > 0) return { tone: 'info', icon: SHIELD_SVG, text: n + (n === 1 ? ' PII Token Masked' : ' PII Tokens Masked'), title: n + ' PII Entities Anonymized: ' + n + ' ישויות הותממו בבקשה האחרונה' };
    return { tone: 'ok', icon: LOCK_SVG, text: 'PII Masked & Secured', title: lastExchange ? 'לא זוהו פרטים מזהים בבקשה האחרונה' : 'התממה אוטומטית פעילה' };
  }

  function renderBadges() {
    const st = badgeState();
    document.querySelectorAll('[data-pii-badge]').forEach((el) => {
      el.className = 'pii-badge pii-badge-' + st.tone;
      el.innerHTML = st.icon + '<span></span>';
      el.querySelector('span').textContent = st.text;
      el.title = st.title;
      el.setAttribute('aria-label', st.text + '. ' + st.title + '. פתיחת פירוט ההתממה');
    });
  }

  // ---- Drawer -----------------------------------------------------------

  const drawer = document.getElementById('pii-drawer');
  const drawerBody = document.getElementById('pii-drawer-body');
  const drawerClose = document.getElementById('pii-drawer-close');
  let view = 'masked'; // 'original' | 'masked' | 'both'
  let returnFocus = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Renders text with [TOKENS] highlighted, via DOM nodes only (never
  // innerHTML), since both sides can contain user / model text.
  function tokenized(text) {
    const box = el('div', 'pii-text');
    const re = /\[\s*[A-Z]+(?:_[A-Z]+)*_\d+\s*\]/g;
    let last = 0;
    for (const m of String(text).matchAll(re)) {
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      box.appendChild(el('mark', 'pii-token', m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
    return box;
  }

  function pane(title, text, masked) {
    const p = el('div', 'pii-pane');
    p.appendChild(el('div', 'pii-pane-title', title));
    p.appendChild(masked ? tokenized(text) : el('div', 'pii-text', text));
    return p;
  }

  function comparison(heading, original, masked) {
    const wrap = el('section', 'pii-section');
    wrap.appendChild(el('h3', 'pii-h3', heading));
    const row = el('div', 'pii-panes' + (view === 'both' ? ' pii-panes-both' : ''));
    if (view !== 'masked') row.appendChild(pane('טקסט מקורי (נשאר במכשיר)', original, false));
    if (view !== 'original') row.appendChild(pane('כפי שנשלח ל-LLM', masked, true));
    wrap.appendChild(row);
    return wrap;
  }

  function renderDrawer() {
    if (!drawerBody) return;
    drawerBody.textContent = '';
    const s = settings();

    const status = el('div', 'pii-status');
    const st = badgeState();
    const b = el('span', 'pii-badge pii-badge-' + st.tone);
    b.innerHTML = st.icon + '<span></span>';
    b.querySelector('span').textContent = st.text;
    status.appendChild(b);
    status.appendChild(el('p', 'pii-muted', s.enabled
      ? 'הזיהוי וההתממה מתבצעים בדפדפן, לפני שהטקסט יוצא מהמכשיר. טבלת ההמרה מוצפנת (AES-256-GCM) ונמחקת בסגירת הדף.'
      : 'ההתממה כבויה. ניתן להפעיל אותה בהגדרות.'));
    drawerBody.appendChild(status);

    if (!lastExchange) {
      drawerBody.appendChild(el('p', 'pii-muted', 'עדיין לא נשלחה בקשה ל-LALUM LEX בדף זה.'));
    } else {
      const sec = el('section', 'pii-section');
      sec.appendChild(el('h3', 'pii-h3', 'ישויות שהוסוו בבקשה האחרונה (' + lastExchange.count + ')'));
      const counts = PII.countByCategory(lastExchange.entities);
      let any = false;
      for (const g of PII.CATEGORY_GROUPS) {
        const items = lastExchange.entities.filter((e) => g.categories.includes(e.category));
        if (!items.length) continue;
        any = true;
        const row = el('div', 'pii-group');
        row.appendChild(el('div', 'pii-group-label', g.label + ' · ' + g.categories.reduce((n, c) => n + (counts[c] || 0), 0)));
        const chips = el('div', 'pii-chips');
        for (const e of items) {
          const c = el('span', 'pii-chip');
          c.appendChild(el('mark', 'pii-token', e.token));
          c.appendChild(document.createTextNode(' ' + (PII.CATEGORY_LABELS[e.category] || e.category)));
          chips.appendChild(c);
        }
        row.appendChild(chips);
        sec.appendChild(row);
      }
      if (!any) sec.appendChild(el('p', 'pii-muted', 'לא זוהו פרטים מזהים בבקשה זו.'));
      drawerBody.appendChild(sec);

      const toggle = el('div', 'tabs pii-view-toggle');
      toggle.setAttribute('role', 'group');
      toggle.setAttribute('aria-label', 'מצב תצוגה');
      [['original', 'מקורי'], ['masked', 'נשלח ל-LLM'], ['both', 'זה לצד זה']].forEach(([k, label]) => {
        const btn = el('button', 'tab' + (view === k ? ' active' : ''), label);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', view === k ? 'true' : 'false');
        btn.addEventListener('click', () => { view = k; renderDrawer(); drawerBody.querySelector('.pii-view-toggle .active').focus(); });
        toggle.appendChild(btn);
      });
      drawerBody.appendChild(toggle);

      drawerBody.appendChild(comparison('הבקשה', lastExchange.original, lastExchange.masked));
      if (lastExchange.maskedReply != null) {
        drawerBody.appendChild(comparison('התשובה', lastExchange.restoredReply, lastExchange.maskedReply));
      }
    }

    const foot = el('div', 'pii-foot');
    foot.appendChild(el('p', 'pii-muted',
      'מגבלה: שמות מזוהים רק מרשימת שמות הלקוח והצדדים שבהגדרות, אחרי תואר (מר, גב׳, עו״ד, ד״ר) או לפני בע״מ. שם שלא הוזן ולא מופיע כך לא יוסווה.'));
    const link = el('a', 'pii-settings-link', 'הגדרות PII Shield');
    link.href = '/pii-settings.html';
    foot.appendChild(link);
    drawerBody.appendChild(foot);
  }

  function openDrawer(trigger) {
    if (!drawer) return;
    returnFocus = trigger || document.activeElement;
    renderDrawer();
    drawer.hidden = false;
    document.querySelectorAll('[data-pii-badge]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
    if (drawerClose) drawerClose.focus();
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    document.querySelectorAll('[data-pii-badge]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  document.addEventListener('click', (e) => {
    const badge = e.target.closest && e.target.closest('[data-pii-badge]');
    if (badge) { e.preventDefault(); openDrawer(badge); }
  });
  if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
  if (drawer) {
    drawer.addEventListener('click', (e) => { if (e.target === drawer) closeDrawer(); });
    drawer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDrawer(); return; }
      if (e.key === 'Tab') {
        const f = [...drawer.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    });
  }

  // Settings may change in another tab (pii-settings.html).
  window.addEventListener('storage', renderBadges);
  // Restored from the back/forward cache after pagehide purged the vault:
  // the masked history lex.js still holds can no longer be unmasked, and new
  // tokens would reuse the old numbers, so the conversation has to restart.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) document.dispatchEvent(new CustomEvent('lalum:pii-vault-reset'));
    renderBadges();
  });
  renderBadges();

  window.LalumPIIShield = { settings, maskOutgoing, unmaskIncoming, recordExchange, audit };
})();
