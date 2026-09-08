// Minimal view router — no framework. Three static screens, switched by
// the bottom nav and reflected in the URL hash so links/back-forward work.

(function () {
  const SCREENS = ['practice', 'risk', 'knowledge', 'community'];
  const title = document.getElementById('screen-title');
  const navItems = document.querySelectorAll('.nav-item');

  function showScreen(name) {
    if (!SCREENS.includes(name)) name = SCREENS[0];

    document.querySelectorAll('.screen').forEach((el) => {
      el.classList.toggle('active', el.id === `screen-${name}`);
    });

    navItems.forEach((btn) => {
      const active = btn.dataset.screen === name;
      btn.classList.toggle('active', active);
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
