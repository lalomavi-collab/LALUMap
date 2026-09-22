// Minimal service worker — enables PWA installability (Chrome's install
// criteria expect a fetch handler) and caches the app shell for offline
// launch. Extend the cache list as real product routes/assets are added.

// v2: the shell was caching index.html but none of the CSS/JS it actually
// needs to render — offline launch worked in name only, since a cached
// index.html with no cached styles.css/app.js/etc. still has to hit the
// network for everything that makes it a working page. Bumping the cache
// name (not just its contents) is what makes activate's own cleanup below
// replace a v1 cache already sitting in a returning visitor's browser.
// v3: dropped /logo-mark.png (precached but referenced by nothing in the
// app; dead weight in the offline cache) and added the three icon files
// index.html's own <head> actually links (apple-touch-icon + both
// favicons) — v2 cached every CSS/JS the shell needs but still missed
// these, so a fully offline launch still had to hit the network for them.
const CACHE_NAME = 'lalum-shell-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/config.js',
  '/app.js',
  '/data.js',
  '/lex.js',
  '/a11y.js',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
