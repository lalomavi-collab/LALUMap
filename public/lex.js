// LALUM LEX chat widget — reuses the existing lalum-assistant Edge Function
// (already deployed, already backs the lalumapp.com site's own chat widget:
// same verified case-law database, same strict anti-hallucination grounding,
// same mandatory not-legal-advice disclaimers). Deliberately does NOT stand
// up a second assistant/system-prompt for the PWA: two personas answering
// legal questions for the same firm would drift out of sync and is exactly
// the kind of duplicated, inconsistent surface worth avoiding.
//
// Stateless by design: the transcript lives only in memory for this page
// load (never written to Supabase), since there's no product reason yet to
// retain what could be a confidential legal question, and every retained
// record is something someone has to secure and account for.

(function () {
  const fab = document.getElementById('lex-fab');
  const dialog = document.getElementById('lex-dialog');
  const closeBtn = document.getElementById('lex-close');
  const messagesEl = document.getElementById('lex-messages');
  const form = document.getElementById('lex-form');
  const input = document.getElementById('lex-input');
  if (!fab || !dialog || !form || !input) return;

  function escapeHTML(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  const client = (window.supabase && window.LALUM_SUPABASE_URL)
    ? window.supabase.createClient(window.LALUM_SUPABASE_URL, window.LALUM_SUPABASE_ANON_KEY)
    : null;

  // Full context sent to the API (includes the invisible /menu opener);
  // apiHistory and the rendered transcript intentionally diverge by one
  // synthetic turn — see openMenu() below.
  let apiHistory = [];
  let opened = false;
  let busy = false;

  function addBubble(role, text) {
    const row = document.createElement('div');
    row.className = 'lex-bubble lex-bubble-' + role;
    row.innerHTML = escapeHTML(text).replace(/\n/g, '<br>');
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addStatus(text) {
    const row = document.createElement('div');
    row.className = 'lex-status';
    row.textContent = text;
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return row;
  }

  async function send(userText, opts) {
    const visible = !(opts && opts.hideUserTurn);
    if (userText && visible) addBubble('user', userText);
    apiHistory = [...apiHistory, { role: 'user', content: userText }];

    if (!client) {
      addBubble('assistant', 'שירות הצ׳אט אינו זמין כרגע (בעיית רשת). רעננו את הדף ונסו שוב.');
      return;
    }

    busy = true;
    input.disabled = true;
    form.querySelector('button[type="submit"]').disabled = true;
    const statusRow = addStatus('LEX מקליד/ה...');

    try {
      const { data, error } = await client.functions.invoke('lalum-assistant', {
        body: { messages: apiHistory },
      });
      statusRow.remove();
      if (error || !data || typeof data.reply !== 'string' || !data.reply.trim()) {
        addBubble('assistant', 'לא הצלחנו לקבל תשובה כרגע. נסו שוב בעוד רגע, או תאמו שיחה ישירות עם ד״ר עו״ד אברהם ללום.');
        return;
      }
      apiHistory = [...apiHistory, { role: 'assistant', content: data.reply }];
      addBubble('assistant', data.reply);
    } catch {
      statusRow.remove();
      addBubble('assistant', 'לא הצלחנו לקבל תשובה כרגע. נסו שוב בעוד רגע.');
    } finally {
      busy = false;
      input.disabled = false;
      form.querySelector('button[type="submit"]').disabled = false;
      input.focus();
    }
  }

  // Zero state: the assistant's own system prompt defines a fixed "menu
  // card" reply for an opening /menu turn. Triggering it for real (rather
  // than hand-copying that text here) means it can never drift out of sync
  // with the actual system prompt. hideUserTurn keeps the synthetic /menu
  // out of the visible transcript — a real visitor never typed it.
  function openMenu() {
    if (apiHistory.length > 0) return; // only once per page load
    send('/menu', { hideUserTurn: true });
  }

  let lastFocused = null;

  function openDialog() {
    lastFocused = document.activeElement;
    dialog.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    input.focus();
    if (!opened) { opened = true; openMenu(); }
  }

  function closeDialog() {
    dialog.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    else fab.focus();
  }

  fab.addEventListener('click', () => {
    if (dialog.hidden) openDialog(); else closeDialog();
  });
  closeBtn.addEventListener('click', closeDialog);

  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDialog();
      return;
    }
    // Minimal focus trap: Tab/Shift+Tab cycle within the dialog's own
    // focusable elements rather than escaping into the screen behind it.
    if (e.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });
})();
