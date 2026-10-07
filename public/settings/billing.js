// Billing: fixed SaaS subscription only. Tier, seats, invoice ledger, change requests,
// and the intake webhook token. There is no per-matter or percentage fee anywhere.
(function () {
  const L = window.LalumCommon, esc = L.esc;
  const root = document.getElementById('ck-root');
  document.getElementById('ck-nav').innerHTML = L.nav('billing');
  const money = (n) => (n == null ? 'לפי הסכם' : Number(n).toLocaleString('he-IL', { style: 'currency', currency: 'ILS' }));

  async function start() {
    const ctx = await L.boot(root, { prompt: 'נדרשת התחברות.' });
    if (!ctx) return;
    const m = ctx.member, firm = m.lalum_firms, firmId = m.firm_id;
    const canManage = ['FIRM_PARTNER', 'ADMIN'].includes(m.role);
    const [plans, members, invoices] = await Promise.all([
      L.safely(L.client.from('lalum_subscription_plans').select('*').order('sort_order')),
      L.safely(L.client.from('lalum_firm_members').select('name, email, role').eq('firm_id', firmId)),
      canManage ? L.safely(L.client.from('lalum_invoices').select('*').eq('firm_id', firmId).order('issued_at', { ascending: false })) : Promise.resolve({ data: [] }),
    ]);
    const used = (members.data || []).length;
    root.innerHTML = `
      <div class="card"><div class="card-row"><div><div class="card-title">${esc(firm.firm_name)}</div><div class="card-meta">מסלול נוכחי: <b>${esc(firm.subscription_tier)}</b> · ${esc(firm.status === 'ACTIVE' ? 'פעיל' : firm.status)}</div></div>
        <div style="text-align:end"><div class="card-title">${money(firm.monthly_fee)} לחודש</div><div class="card-meta">דמי מנוי קבועים, ללא חלוקת שכר טרחה</div></div></div></div>
      <div class="ck-ok">LALUM גובה דמי מנוי קבועים בלבד. אין חלוקת שכר טרחה, אחוזים או שיתוף הכנסות, והלקוח מתקשר ישירות עם המשרד המטפל.</div>
      <div class="section-label">מסלולי מנוי</div>
      <div class="ck-grid2">${(plans.data || []).map((p) => `<div class="card"><div class="card-row"><span class="card-title">${esc(p.display_name)}</span>${p.tier === firm.subscription_tier ? '<span class="pill pill-green">המסלול שלכם</span>' : ''}</div>
        <div class="card-meta">${esc(p.description)}</div><div class="card-meta">מחיר: ${money(p.monthly_fee_ils)}${p.seat_limit ? ` · עד ${esc(p.seat_limit)} מושבים` : ''}</div>
        ${canManage && p.tier !== firm.subscription_tier ? `<button class="ck-btn" data-req="${esc(p.tier)}">בקשת מעבר למסלול</button>` : ''}</div>`).join('')}</div>
      <div id="req-status" aria-live="polite"></div>
      <div class="section-label">מושבים</div>
      <div class="card"><div class="bar-row"><span>${used} מתוך ${esc(firm.seat_limit)} מושבים בשימוש</span><span>${Math.round((used / firm.seat_limit) * 100)}%</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, (used / firm.seat_limit) * 100)}%"></div></div>
        <div class="ck-table-wrap" style="margin-top:10px"><table class="ck-table"><thead><tr><th>שם</th><th>דוא"ל</th><th>תפקיד</th></tr></thead><tbody>${(members.data || []).map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${esc(L.ROLE[x.role] || x.role)}</td></tr>`).join('')}</tbody></table></div>
        ${canManage ? '<div class="ck-note">הוספת משתמשים והגדלת מושבים מתבצעות מול LALUM, וכל שינוי מופיע בחשבונית הבאה.</div>' : ''}</div>
      ${canManage ? `<div class="section-label">יומן חשבוניות</div>
      <div class="ck-table-wrap"><table class="ck-table"><thead><tr><th>מס'</th><th>סוג</th><th>תקופה</th><th>סכום</th><th>מע"מ</th><th>סטטוס</th></tr></thead><tbody>
        ${(invoices.data || []).map((i) => `<tr><td>${esc(i.invoice_no)}</td><td>${i.kind === 'SUBSCRIPTION' ? 'מנוי' : 'מושבים נוספים'}</td><td>${esc(i.period_start)} עד ${esc(i.period_end)}</td><td>${money(i.net_amount)}</td><td>${money(i.vat_amount)}</td><td>${esc({ ISSUED: 'הופקה', PAID: 'שולמה', VOID: 'מבוטלת' }[i.status] || i.status)}</td></tr>`).join('') || '<tr><td colspan="6">אין חשבוניות עדיין</td></tr>'}</tbody></table></div>
      <div class="section-label">חיבור קליטה אוטומטית (Webhook)</div>
      <div class="card"><div class="card-meta">כתובת: <code dir="ltr">${esc(window.LALUM_SUPABASE_URL)}/functions/v1/lalum-pipeline/api/v1/intake/webhook</code><br>כותרות: <code dir="ltr">Authorization: Bearer &lt;token&gt;</code> ו-<code dir="ltr">x-lalum-firm: ${esc(firmId)}</code><br>גוף: JSON עם <code dir="ltr">text</code>, ואופציונלית <code dir="ltr">parties</code>.</div>
        <div class="ck-row"><button class="ck-btn" id="rotate">יצירת טוקן חדש (מבטל את הקודם)</button></div><div id="token-out" aria-live="polite"></div></div>` : ''}`;
    root.querySelectorAll('[data-req]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('לשלוח בקשת מעבר מסלול? הבקשה תטופל מול LALUM ואינה משנה את החיוב מיד.')) return;
      const { error } = await L.safely(L.client.from('lalum_tier_change_requests').insert({ firm_id: firmId, requested_by: ctx.session.user.id, from_tier: firm.subscription_tier, to_tier: b.dataset.req }));
      document.getElementById('req-status').innerHTML = error ? `<div class="ck-err">${esc(error.message)}</div>` : '<div class="ck-ok">הבקשה נשלחה. נחזור אליכם.</div>';
    }));
    const rot = document.getElementById('rotate');
    if (rot) rot.addEventListener('click', async () => {
      if (!confirm('יצירת טוקן חדש תנתק כל חיבור קיים. להמשיך?')) return;
      const { data, error } = await L.safely(L.client.rpc('lalum_rotate_intake_token', { p_firm: firmId }));
      document.getElementById('token-out').innerHTML = error ? `<div class="ck-err">${esc(error.message)}</div>` : `<div class="ck-warn">הטוקן מוצג פעם אחת בלבד. שמרו אותו עכשיו:</div><code dir="ltr" style="word-break:break-all;display:block;padding:8px">${esc(data)}</code>`;
    });
  }
  start();
})();
