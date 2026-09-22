// Minimal view router — no framework. Three static screens, switched by
// the bottom nav and reflected in the URL hash so links/back-forward work.

(function () {
  const SCREENS = ['practice', 'risk', 'knowledge', 'community'];
  const title = document.getElementById('screen-title');
  const navItems = document.querySelectorAll('.nav-item');

  function showScreen(name) {
    if (!SCREENS.includes(name)) name = SCREENS[0];

    document.querySelectorAll('.screen').forEach((el) => {
      const active = el.id === `screen-${name}`;
      el.classList.toggle('active', active);
      // Belt-and-suspenders alongside the CSS display toggle above: the
      // HTML spec only allows more than one <main> per document when every
      // extra one carries `hidden` (we have four, one visible at a time).
      el.hidden = !active;
    });

    navItems.forEach((btn) => {
      const active = btn.dataset.screen === name;
      btn.classList.toggle('active', active);
      // aria-current carries the "which screen am I on" signal to AT users;
      // the active/inactive classes alone only reach sighted users.
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
      if (active) title.textContent = btn.dataset.title;
    });

    document.dispatchEvent(new CustomEvent('lalum:screenchange', { detail: { name: name } }));
  }

  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.screen;
      history.pushState(null, '', `#${name}`);
      showScreen(name);
    });
  });

  window.addEventListener('popstate', () => {
    showScreen(location.hash.slice(1));
  });

  showScreen(location.hash.slice(1));
})();

// ביקורת AI — mode switcher across the four practice pillars (real estate /
// TAMA 38, AI governance, M&A / due diligence, mediation / DOM). Still
// sample data (see README: this screen has no schema behind it yet) — only
// the switcher and the tone system are real, and the tone system (ok / warn
// / risk) matches the risk-badge language already live on lalumapp.com, so
// the same "score → colour" vocabulary reads the same on both properties.
(function () {
  const TONE = {
    ok: { bg: 'var(--green-bg)', fg: 'var(--green)', label: 'סיכון: נמוך' },
    warn: { bg: 'var(--amber-bg)', fg: 'var(--amber)', label: 'סיכון: בינוני' },
    risk: { bg: 'var(--red-bg)', fg: 'var(--red)', label: 'סיכון: גבוה' },
  };

  const MODES = [
    {
      id: 'ai', label: 'ממשל AI', matter: 'pricing-engine-v3', meta: 'הועלה · נסרק לפני 2 דק׳',
      score: 78, tone: 'warn', scoreLabel: 'ציון תאימות EU AI Act',
      bars: [['DOM', 82], ['RECIR', 74], ['SRME', 91]],
    },
    {
      id: 'realestate', label: 'נדל״ן · תמ״א 38', matter: 'הסכם קומבינציה, מתחם הרצל 12', meta: 'הועלה · נסרק לפני 6 דק׳',
      score: 88, tone: 'ok', scoreLabel: 'ציון בדיקת הסכם יזם',
      bars: [['בטוחות וערבויות', 90], ['מנגנון איחור ופיצוי', 84], ['שוויון תמורות', 89]],
    },
    {
      id: 'ma', label: 'מיזוגים ורכישות', matter: 'רכישת מניות, Series B', meta: 'הועלה · נסרק אתמול',
      score: 61, tone: 'warn', scoreLabel: 'ציון בדיקת נאותות',
      bars: [['בדיקת נאותות', 58], ['מצגים ואחריות', 66], ['התניות השלמה', 60]],
    },
    {
      id: 'mediation', label: 'גישור (DOM)', matter: 'גישור, סכסוך שכנים, מתחם רוטשילד', meta: 'הועלה · נסרק לפני שעה',
      score: 42, tone: 'risk', scoreLabel: 'מיפוי מוכנות להסדר',
      bars: [['מיפוי סוגיות', 45], ['מתאם ראיות', 38], ['מודל הסדר', 44]],
    },
  ];

  const tabsEl = document.getElementById('risk-tabs');
  const contentEl = document.getElementById('risk-content');
  if (!tabsEl || !contentEl) return;

  const CIRC = 389.6; // 2π·62, the existing ring's radius — kept identical so the gauge doesn't jump size between modes.

  function render(mode) {
    const tone = TONE[mode.tone];
    const offset = Math.round(CIRC * (1 - mode.score / 100));
    contentEl.innerHTML = `
      <div class="card" style="flex-direction: row; align-items: center; gap: 12px;">
        <div style="width:38px;height:38px;border-radius:10px;background:${tone.bg};display:flex;align-items:center;justify-content:center;flex-shrink:0;" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${tone.fg}" stroke-width="2" stroke-linecap="round" focusable="false"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
        <div>
          <div class="card-title">${mode.matter}</div>
          <div class="card-meta">${mode.meta}</div>
        </div>
      </div>

      <div class="ring-wrap">
        <svg width="148" height="148" viewBox="0 0 148 148" role="img" aria-label="${mode.scoreLabel}: ${mode.score} מתוך 100, ${tone.label}" focusable="false">
          <circle cx="74" cy="74" r="62" fill="none" stroke="rgba(26,24,21,.08)" stroke-width="10"/>
          <circle cx="74" cy="74" r="62" fill="none" stroke="${tone.fg}" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${CIRC}" stroke-dashoffset="${offset}" transform="rotate(-90 74 74)"/>
          <text x="74" y="70" text-anchor="middle" fill="var(--text)" font-family="Jost, sans-serif" font-size="34" font-weight="500">${mode.score}</text>
          <text x="74" y="92" text-anchor="middle" fill="var(--text-secondary)" font-family="Manrope, sans-serif" font-size="11">מתוך 100</text>
        </svg>
        <span class="card-meta">${mode.scoreLabel}</span>
        <span class="pill pill-${mode.tone === 'ok' ? 'green' : mode.tone === 'warn' ? 'amber' : 'red'}">${tone.label}</span>
      </div>

      ${mode.bars.map(([label, val]) => `
      <div>
        <div class="bar-row"><span>${label}</span><span>${val}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${val}%"></div></div>
      </div>`).join('')}

      <button class="btn-primary" type="button" style="background:none;border:1px solid var(--border-strong);color:var(--text);">צפייה בדוח מלא</button>
    `;
  }

  tabsEl.innerHTML = MODES.map((m, i) => `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-mode="${m.id}" role="tab" aria-selected="${i === 0}">${m.label}</button>`).join('');

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    tabsEl.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === btn);
      t.setAttribute('aria-selected', String(t === btn));
    });
    render(MODES.find((m) => m.id === btn.dataset.mode));
  });

  render(MODES[0]);
})();

// מרכז ידע — the same four practice-pillar filter as ביקורת AI, so picking
// a domain means the same thing on both screens. Still sample cards (2 per
// domain) — only the filter itself is real, matching the pattern already
// established for ביקורת AI.
(function () {
  const DOMAINS = [
    {
      id: 'realestate', label: 'נדל״ן · תמ״א 38',
      cards: [
        { tag: 'תמ״א 38', title: 'בג״ץ 1720/24', body: 'בית המשפט קבע כי חובת יידוע הדיירים חלה גם על עסקאות משולבות, ולא ניתן להסתפק בגילוי חלקי' },
        { tag: 'פינוי בינוי', title: 'ע״א 5502/23', body: 'נדחתה טענת קיפוח מיעוט הדיירים בהעדר חוות דעת שמאית עצמאית מטעמם' },
      ],
    },
    {
      id: 'ai', label: 'ממשל AI',
      cards: [
        { tag: 'GPAI', title: 'החלטת אכיפה 2/26', body: 'ספק מודל שימוש כללי (GPAI) חייב לתעד מקורות אימון גם כאשר המודל משולב במוצר צד ג׳' },
        { tag: 'אחריות אלגוריתמית', title: 'ת״א 4410-25', body: 'נדחתה טענת הגנה של "המערכת החליטה": אחריות המפעיל האנושי לא פוקעת בהיעדר בקרה מתועדת' },
      ],
    },
    {
      id: 'ma', label: 'מיזוגים ורכישות',
      cards: [
        { tag: 'מצגים ואחריות', title: 'ת״א 8821-24', body: 'מצג כוזב בדוח פיננסי שנחשף בבדיקת נאותות מקנה עילת ביטול, גם כשההסכם כלל תניית "as-is"' },
        { tag: 'בדיקת נאותות', title: 'ע״א 1290/25', body: 'חובת גילוי יזום חלה על המוכר גם בהיעדר שאלה מפורשת של הרוכש, כשמדובר במידע מהותי' },
      ],
    },
    {
      id: 'mediation', label: 'גישור (DOM)',
      cards: [
        { tag: 'אכיפת הסדר', title: 'רע״א 3350/25', body: 'הסכם גישור שנחתם בפני מגשר מוסמך אוכף כפסק דין, גם בלי אישור בית משפט בדיעבד' },
        { tag: 'מיפוי סוגיות', title: 'מודל DOM', body: 'הפרדת סוגיות עמדה מסוגיות אינטרס מקצרת משא ומתן בגישור, לפי מדגם הפרקטיקה' },
      ],
    },
  ];

  const tabsEl = document.getElementById('knowledge-domains');
  const cardsEl = document.getElementById('knowledge-cards');
  if (!tabsEl || !cardsEl) return;

  // Decorative and inert (no click handler wired to it yet), so hidden from
  // assistive tech rather than announced as an unlabelled, non-functional button.
  const bookmarkIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.6" aria-hidden="true" focusable="false"><path d="M6 3h12v18l-6-4-6 4V3z"/></svg>';

  function render(domain) {
    cardsEl.innerHTML = domain.cards.map((c) => `
      <div class="card">
        <div class="card-row"><span class="tag">${c.tag}</span>${bookmarkIcon}</div>
        <div class="card-title">${c.title}</div>
        <p class="card-meta" style="line-height:1.6; margin:0;">${c.body}</p>
        <span class="card-meta" style="font-size:11px;">תקציר דקה</span>
      </div>`).join('');
  }

  tabsEl.innerHTML = DOMAINS.map((d, i) => `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-domain="${d.id}" role="tab" aria-selected="${i === 0}">${d.label}</button>`).join('');
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    tabsEl.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === btn);
      t.setAttribute('aria-selected', String(t === btn));
    });
    render(DOMAINS.find((d) => d.id === btn.dataset.domain));
  });
  render(DOMAINS[0]);
})();
