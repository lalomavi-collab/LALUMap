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

Signing out: the header's avatar circle (`#header-avatar`) is hidden while signed out and becomes a real sign-out button once a session exists (`data.js`'s `updateHeaderAvatar`, called from both `onAuthStateChange` and the initial `getSession` check), calling `client.auth.signOut()`. `cookies.html` describes this as the way to clear the stored session token.

## Newsletter — daily short update, opt-in, human-approved before every send

The "עדכון יומי" card on מרכז ידע lets anyone subscribe with just an email (no auth) via the public `lalum-newsletter-subscribe` edge function, which upserts into `public.lalum_newsletter_subscribers` (mirrors `lalum_leads`'s consent pattern: `consent_at` + the exact consent wording shown at signup, for Privacy Law Amendment 13). Every sent email carries a one-click unsubscribe link (`lalum-newsletter-unsubscribe`, token-based, no login needed).

The actual daily send (`lalum-newsletter-daily`) is on a `pg_cron` schedule (06:00 UTC) but is **content-gated by design**: it only ever sends a row from `public.lalum_newsletter_updates` that a human has flipped from `draft` to `approved`. An empty or all-draft queue means the cron tick is a silent no-op — nothing is ever auto-generated or auto-approved. To actually send a day's update: write/edit a row in `lalum_newsletter_updates`, set its `status` to `approved`, and the next cron tick (or a manual invoke) sends it once and marks it `sent`.

The **published Artifact mockup** (Claude Design canvas / the standalone `LALUM App` demo) is intentionally **not** wired to Supabase: an Artifact's CSP blocks `fetch`/XHR to any host outside its own origin (Google Fonts excepted), so it technically cannot reach `supabase.co` even if code were added. It stays static/sample content — that's a hard technical boundary, not a policy choice, and it's the reason the shareable Artifact link can never leak real client data.

## Verifying this actually works

This sandbox's outbound network policy blocks `cdn.jsdelivr.net` and `*.supabase.co`, so the Supabase Auth flow and data fetch could not be exercised end-to-end from here — only the graceful-failure path (library fails to load → visible error, not a blank screen) was verified. **Before relying on this in production**, open the deployed page in a normal browser and confirm: the magic-link sign-in actually arrives by email, an admin session shows real contacts, a non-admin session shows the "no permission" state (not an error), and a signed-in user can post to and see the community feed.

## CI (`.github/workflows/check.yml`)

There's no build step here (framework-free static files), so nothing else catches a broken commit before it ships. `scripts/check.mjs` (pure Node, no dependencies) runs on every push/PR and checks: JS syntax, duplicate `id`s per page, forbidden em/en-dashes in real page content per the punctuation rule (never inside a comment), and that every `href` resolves — a same-page `#anchor` to an existing `id`, a `/path` to an existing file. All four are checks a manual audit found real, already-shipped violations from; this makes sure the next one doesn't ship silently. Run it locally with `node scripts/check.mjs`.

## Cockpit: automated intake pipeline (new)

A multi-tenant law-firm module living next to the PWA. User-facing walkthrough: `public/guide.html` (linked from the app header, a promo card on the first screen, and every cockpit page's nav).

**What it does.** Every payload (uploaded text, intake webhook message, chat prompt) goes through `AutomatedPipelineAgent.process()` before anything can reach an LLM: (1) PII shield, (2) conflict check, (3) practice-area detection and playbook risk scoring, (4) hash-chained audit entry and dual dispatch. A RED conflict halts and returns one fixed neutral sentence. Export of a document is blocked until a 4-step human sign-off is valid for the exact current text (verified in Postgres by content hash, and re-checked by the export endpoint).

| Piece | Where |
|---|---|
| Schema, RLS, RPCs (additive, all `lalum_*`; the old `public.matters` email-router table is untouched) | `supabase/migrations/` |
| Pipeline agent, anonymizer, conflict engine, playbook engine, ephemeral vault, audit/routing | `lib/ai`, `lib/crypto`, `lib/services` |
| Interception layer (Web Request/Response, framework-agnostic) | `middleware/pipelineMiddleware.ts` |
| Edge function `lalum-pipeline` (`/api/v1/documents/{upload,draft,analyze,export}`, `/api/v1/intake/webhook`, `/api/v1/chat`) | `supabase/functions/lalum-pipeline/index.ts` |
| UI: `/workspace/` (3-panel cockpit), `/admin/matters.html`, `/settings/billing.html`, `/guide.html`, `/legal/*` | `public/` |
| Tests and strict typecheck | `tests/`, `npm test`, `npm run typecheck` |

**Why not Next.js + Prisma as first specified.** This repo is a framework-free static PWA on a Supabase backend; a second app stack would have split the product. The schema is SQL migrations (Prisma enums became text + CHECK; Prisma's `@default(COMMERCIAL)` is not a value of its own enum, so `COMMERCIAL_MA` is the default). The lib code is erasable TypeScript so it runs on Deno, Node and tsc unchanged.

**Deploy.** Migrations were applied to `lalum-app` through the Supabase MCP in small chunks (the tool times out on large ones, and on any chunk containing a DELETE statement; sign-off revocation therefore marks the row `REVOKED` instead of deleting), so the remote migration history has its own timestamps. The function imports from `lib/` and `middleware/`, so bundle before deploy: `npx esbuild supabase/functions/lalum-pipeline/index.ts --bundle --format=esm --platform=neutral --target=es2022 --external:npm:* --outfile=dist/index.js`, deploy with `verify_jwt: false` (the intake webhook has no user JWT; every route authenticates itself and fails closed).

**Privacy design, precisely.** The original file and the token to value map are never stored: the map lives in a request-scoped AES-256-GCM vault destroyed at the end of the request; the browser keeps the original in memory for the session only (PII inspector, name restore on export). The database stores masked text, analysis and PII-free audit rows. Conflict parties are per-firm HMAC blind indexes, never names. The platform admin has no policy on `lalum_matter_documents`. This is not "no data retained": masked content is retained for the firm's work.

**Known gaps (say so before relying on it).**
- Partner e-mail / WhatsApp notifications are queued in `lalum_dispatch_outbox` (PII-free); no sender worker exists yet.
- The Hebrew name detector is rules-based (titles, ID context, declared parties, "בע"מ"). It can miss undeclared names and over-masks some words before "ת.ז.". Declaring party names at intake is what makes conflict checks reliable.
- `lalum_practice_playbooks` is seeded with 33 draft rules pending attorney review; statutes are cited without section numbers on purpose.
- The existing `pii-gateway` function already has a stronger matter-scoped vault and LLM proxy (its source package `@lalum/pii-shield` is not in this repo). The cockpit anonymizer duplicates part of it; consolidate when that package is available. Cockpit chat forwards only masked text, through `pii-gateway`.
- Legal pages are drafts. They cite Israel Bar ethics opinion 60/24, ABA Op. 512 and EU AI Act arts. 12 and 50 as instructed; none were verified against the sources. The DPA has 7 clauses (the brief named 6; the 7th, security / audit / breach notice, is an addition).
- This sandbox cannot reach `*.supabase.co`, so the deployed function was not exercised over HTTP. Logic is covered by `tests/`; the SQL was exercised in rolled-back transactions (tenant isolation, role gates, sign-off, audit-chain verification). Run one real upload in a browser before relying on it.
- Provisioning a firm: a platform admin calls `lalum_admin_create_firm(jsonb)` then `lalum_admin_add_member(firm, email, name, role)` (the person must have signed in once). No UI yet.

## Next steps

- Wire ביקורת AI and מרכז ידע to real tables when there's a schema for them; they're still static/sample. Deliberately not attempted without a live decision from the operator: both would need new tables/RLS policies on `lalum-app`'s shared production database (the same project handling billing, calls, and an unrelated email-routing system), which isn't a change to make unattended.
- Extend `service-worker.js`'s cache list as routes/assets grow (currently `v3`).
- Consider enabling Supabase Auth's leaked-password protection (Authentication → Attack Protection in the dashboard; no API/MCP tool exposes this) and reviewing the `pg_net`-in-`public`-schema advisory noted by `get_advisors` — both pre-date this change but are worth a look. `get_advisors` also flags `lalum_is_admin()` as a `SECURITY DEFINER` function callable directly by any authenticated user via `/rest/v1/rpc/lalum_is_admin`; it only ever returns the caller's own admin status (never another user's data), and revoking that without testing risks breaking the RLS policies that call it internally, so left as-is pending a deliberate look rather than an unattended change.
