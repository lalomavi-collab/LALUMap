// pii-settings.html: load / save PII Shield settings via pii-shield.js's
// own loadSettings / saveSettings, so the page and the chat can never
// disagree on where or how settings are stored.
(function () {
  const PII = window.LalumPII;
  const form = document.getElementById('pii-settings-form');
  const status = document.getElementById('pii-settings-status');
  if (!PII || !form) return;

  const RULES = ['maskNames', 'maskIds', 'maskContact', 'maskLand', 'maskAmounts'];
  function store(kind) { try { return window[kind]; } catch { return null; } }
  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);

  const s = PII.loadSettings(store('localStorage'), store('sessionStorage'));
  const enabled = document.getElementById('pii-enabled');
  enabled.checked = s.enabled;
  RULES.forEach((k) => { document.getElementById('pii-' + k).checked = !!s[k]; });
  document.getElementById('pii-clientNames').value = s.clientNames.join('\n');
  document.getElementById('pii-partyNames').value = s.partyNames.join('\n');

  function syncDisabled() {
    document.querySelectorAll('#pii-rules input').forEach((i) => { i.disabled = !enabled.checked; });
  }
  enabled.addEventListener('change', syncDisabled);
  syncDisabled();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const next = { enabled: enabled.checked };
    RULES.forEach((k) => { next[k] = document.getElementById('pii-' + k).checked; });
    next.clientNames = lines(document.getElementById('pii-clientNames').value);
    next.partyNames = lines(document.getElementById('pii-partyNames').value);
    try {
      PII.saveSettings(next, store('localStorage'), store('sessionStorage'));
      status.style.color = 'var(--green-text)';
      status.textContent = 'ההגדרות נשמרו. הן יחולו על ההודעה הבאה ל-LALUM LEX.';
    } catch {
      status.style.color = 'var(--red-text)';
      status.textContent = 'לא ניתן היה לשמור: הדפדפן חוסם אחסון מקומי (למשל בגלישה פרטית).';
    }
  });
})();
