# LALUM

PWA scaffold for [Lalumapp.com](https://lalumapp.com) — the first commit in this repository.

## What's here

- `public/manifest.json` — PWA manifest (`display: "standalone"`, full icon set, RTL/Hebrew).
- `public/icons/` — generated icon set (72–512px, maskable 192/512, apple-touch-icon, favicons).
- `public/logo-mark.png` — LALUM wordmark asset (transparent, white).
- `public/index.html` — minimal app-shell placeholder that registers the manifest and service worker, so installability can be verified before real product screens land.
- `public/service-worker.js` — minimal cache-the-shell service worker (Chrome's install prompt expects a fetch handler).

## Note on scope

This branch (`claude/customer-notification-rea-failure-u8x03o`) was originally set up for a legal customer-notification feature (רע"א), unrelated to this PWA scaffold. This is currently the only content in the repository — confirm with the repo owner whether the manifest/PWA work belongs on its own branch before merging.

## Next steps

- Replace `public/index.html` with the real app shell/framework once chosen.
- Verify install prompt on a real device: the manifest's `display: "standalone"` only takes effect once the PWA is installed to the home screen — that's what removes the browser chrome (address bar, tabs) shown in the reel-script mockups.
- Extend `service-worker.js`'s cache list as real routes/assets are added.
