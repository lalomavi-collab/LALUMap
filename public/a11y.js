// Accessibility widget: text size, high contrast, and underline-links, each
// genuinely functional via the `[data-a11y-*]` attribute rules in
// styles.css — not a decorative icon. Independent implementation for this
// app's own light/warm design (see styles.css's brand comment); no code
// shared with copartner-ai's own separate widget, and no connection to
// whatever lalumapp.com's marketing site runs — only the idea of "an
// accessibility icon should be here" carried over, per the standing rule
// that these two products never share code.
//
// Present on every page that includes this script (index.html and every
// standalone legal page), each with its own copy of the same static markup
// (see index.html / privacy.html etc.) since there's no shared layout
// component in this framework-free codebase to inject it from once.

(function () {
  const STORAGE_KEY = 'lalum_a11y_settings';
  const FONT_SCALES = [1, 1.15, 1.3, 1.45];
  const DEFAULTS = { fontScale: 1, highContrast: false, underlineLinks: false };

  function getSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        fontScale: FONT_SCALES.includes(parsed.fontScale) ? parsed.fontScale : DEFAULTS.fontScale,
        highContrast: Boolean(parsed.highContrast),
        underlineLinks: Boolean(parsed.underlineLinks),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function persist(settings) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
  }

  function apply(settings) {
    const root = document.documentElement;
    root.setAttribute('data-a11y-fontscale', String(settings.fontScale));
    root.toggleAttribute('data-a11y-contrast', settings.highContrast);
    root.toggleAttribute('data-a11y-underline', settings.underlineLinks);
  }

  // Applied immediately (before DOMContentLoaded even fires, since this
  // script runs inline at its <script> tag position): a returning visitor
  // never sees an unstyled flash of their previous choice being undone.
  let settings = getSettings();
  apply(settings);

  document.addEventListener('DOMContentLoaded', () => {
    const fab = document.getElementById('a11y-fab');
    const panel = document.getElementById('a11y-panel');
    const decreaseBtn = document.getElementById('a11y-decrease');
    const increaseBtn = document.getElementById('a11y-increase');
    const contrastToggle = document.getElementById('a11y-contrast-toggle');
    const underlineToggle = document.getElementById('a11y-underline-toggle');
    const resetBtn = document.getElementById('a11y-reset');
    if (!fab || !panel) return;

    function syncControls() {
      if (decreaseBtn) decreaseBtn.disabled = settings.fontScale === FONT_SCALES[0];
      if (increaseBtn) increaseBtn.disabled = settings.fontScale === FONT_SCALES[FONT_SCALES.length - 1];
      if (contrastToggle) contrastToggle.checked = settings.highContrast;
      if (underlineToggle) underlineToggle.checked = settings.underlineLinks;
    }

    function update(patch) {
      settings = { ...settings, ...patch };
      persist(settings);
      apply(settings);
      syncControls();
    }

    function stepFont(direction) {
      const i = FONT_SCALES.indexOf(settings.fontScale);
      const next = FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, i + direction))];
      update({ fontScale: next });
    }

    function setOpen(open) {
      panel.hidden = !open;
      fab.setAttribute('aria-expanded', String(open));
      if (open) (decreaseBtn || panel).focus();
      else fab.focus();
    }

    fab.addEventListener('click', () => setOpen(panel.hidden));
    decreaseBtn && decreaseBtn.addEventListener('click', () => stepFont(-1));
    increaseBtn && increaseBtn.addEventListener('click', () => stepFont(1));
    contrastToggle && contrastToggle.addEventListener('change', (e) => update({ highContrast: e.target.checked }));
    underlineToggle && underlineToggle.addEventListener('change', (e) => update({ underlineLinks: e.target.checked }));
    resetBtn && resetBtn.addEventListener('click', () => { settings = { ...DEFAULTS }; persist(settings); apply(settings); syncControls(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) setOpen(false);
    });
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== fab && !fab.contains(e.target)) setOpen(false);
    });

    syncControls();
  });
})();
