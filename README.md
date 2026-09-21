# LALUM

PWA for [Lalumapp.com](https://lalumapp.com).

## What's here

- `public/manifest.json` — PWA manifest (`display: "standalone"`, full icon set, RTL/Hebrew).
- `public/icons/` — generated icon set (72–512px, maskable 192/512, apple-touch-icon, favicons).
- `public/index.html` — the real app shell: 4 screens (לקוחות / ביקורת AI / מרכז ידע / קהילה), hash-routed, no framework.
- `public/styles.css` — design tokens + component styles.
- `public/app.js` — screen switcher (nav clicks + hash routing), fires `lalum:screenchange` for `data.js` to hook.
- `public/config.js` — public Supabase project URL + publishable (anon) key. Safe to expose client-side — see below.
- `public/data.js` — Supabase Auth (magic link) + data for the two real-data screens.
- `public/service-worker.js` — minimal cache-the-shell service worker (Chrome's install prompt expects a fetch handler).
- `public/privacy.html`, `public/terms.html`, `public/security.html`, `public/accessibility.html`,
  `public/cookies.html` — the legal-links row exposed from the header on every screen (`.legal-links` in
  `index.html`). Each one is accurate to what the app actually does today, not a generic template; `privacy.html`,
  `terms.html` and `security.html` are marked as drafts pending attorney sign-off (same pattern as the rest of this
  file's legal content), while `accessibility.html` is written as an honest, dated statement of what has and hasn't
  been done rather than a claim of certified compliance, per what Israeli accessibility regulations actually expect
  from that document. `cookies.html` currently has nothing to toggle (no analytics in this app yet — see below), so
  it says that plainly instead of showing a fake settings switch.

## Real data — what's connected and why it's safe to be public code

The Supabase project behind this app (`lalum-app`) is the firm's live backend — it already holds real client/consultation/billing data unrelated to this screen. Only two tables are wired into the UI, and both rely on Postgres Row Level Security, not UI hiding, to keep data private:

- **`lalum_contacts`** (לקוחות screen) — `SELECT` restricted to `lalum_is_admin()` (`admin_read_contacts`). `INSERT` (the "לקוח חדש" form) is gated the same way, by its own policy (`admin_insert_contacts`, `with check (lalum_is_admin())`): a non-admin session is rejected at the database itself even if it somehow reached the form. No `UPDATE`/`DELETE` policy exists — editing or removing a contact isn't wired up, on either the UI or the database side.
- **`lalum_group_chat_messages`** (קהילה screen) — `SELECT`/`INSERT` require any signed-in session (`auth.uid() IS NOT NULL`); not public.

Because RLS enforces this at the database, the anon/publishable key in `config.js` is safe to ship in public code (including this public repo) — it identifies the project, it does not grant access. **The one thing that must never happen is adding a table or policy that lets the `anon` role read either table directly** — always go through an authenticated session.

## Newsletter — daily short update, opt-in, human-approved before every send

The "עדכון יומי" card on מרכז ידע lets anyone subscribe with just an email (no auth) via the public `lalum-newsletter-subscribe` edge function, which upserts into `public.lalum_newsletter_subscribers` (mirrors `lalum_leads`'s consent pattern: `consent_at` + the exact consent wording shown at signup, for Privacy Law Amendment 13). Every sent email carries a one-click unsubscribe link (`lalum-newsletter-unsubscribe`, token-based, no login needed).

The actual daily send (`lalum-newsletter-daily`) is on a `pg_cron` schedule (06:00 UTC) but is **content-gated by design**: it only ever sends a row from `public.lalum_newsletter_updates` that a human has flipped from `draft` to `approved`. An empty or all-draft queue means the cron tick is a silent no-op — nothing is ever auto-generated or auto-approved. To actually send a day's update: write/edit a row in `lalum_newsletter_updates`, set its `status` to `approved`, and the next cron tick (or a manual invoke) sends it once and marks it `sent`.

The **published Artifact mockup** (Claude Design canvas / the standalone `LALUM App` demo) is intentionally **not** wired to Supabase: an Artifact's CSP blocks `fetch`/XHR to any host outside its own origin (Google Fonts excepted), so it technically cannot reach `supabase.co` even if code were added. It stays static/sample content — that's a hard technical boundary, not a policy choice, and it's the reason the shareable Artifact link can never leak real client data.

## Verifying this actually works

This sandbox's outbound network policy blocks `cdn.jsdelivr.net` and `*.supabase.co`, so the Supabase Auth flow and data fetch could not be exercised end-to-end from here — only the graceful-failure path (library fails to load → visible error, not a blank screen) was verified. **Before relying on this in production**, open the deployed page in a normal browser and confirm: the magic-link sign-in actually arrives by email, an admin session shows real contacts, a non-admin session shows the "no permission" state (not an error), and a signed-in user can post to and see the community feed.

## Next steps

- Wire ביקורת AI and מרכז ידע to real tables when there's a schema for them; they're still static/sample.
- Extend `service-worker.js`'s cache list as routes/assets grow.
- Consider enabling Supabase Auth's leaked-password protection and reviewing the `pg_net`-in-`public`-schema advisory noted by `get_advisors` — both pre-date this change but are worth a look.
