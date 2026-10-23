# Handoff: open items (updated 2026-10-23)

State in one paragraph: the cockpit, the inbound e-mail channel, the originals vault, the recycle bin and legal hold are merged. In production `lalum-pipeline` runs **v24** (deployed 2026-10-17, `/selftest` verified, synthetic document masked correctly). v25 (a verb after a party title is not a name) and v26 (dedicated `PII_GATEWAY_TOKEN` for the pii-gateway call) are on `main` in `lalomavi-collab/desktop-tutorial` (`lalum-app/supabase/functions/lalum-pipeline/index.js`, commit `147132d`) and are **not deployed**. Until v26 is live, the cockpit chat authenticates to pii-gateway with the service-role key.

Checked read-only on 2026-10-23: `pii_shield.gateway_clients` has no active row (one revoked smoke-test row from 2026-10-06); the last inquiry stored is from 2026-10-09; test matter `L-2026-0022` is open with no legal hold.

## 1. Gateway token, then deploy v26 (blocking; order is mandatory)
`PII_GATEWAY_TOKEN` currently holds a Resend key that was pasted there by mistake on 2026-10-17. Deploying v26 before it is replaced breaks the cockpit chat (pii-gateway accepts only `lpg_` tokens whose SHA-256 is an active row).
1. Owner, locally in PowerShell: generate `lpg_` + 48 hex characters, copy it to the clipboard without printing it, print only its SHA-256 (lowercase hex, UTF-8). The block is in the owner's task panel.
2. Owner: paste the clipboard into `PII_GATEWAY_TOKEN` at https://supabase.com/dashboard/project/meoymkcotomoluwlwues/functions/secrets , then clear the clipboard. Send only the 64-character hash.
3. Assistant, on "הכנס": `insert into pii_shield.gateway_clients (name, token_hash) values ('lalum-pipeline', '<hash>')` (tenant defaults to `pii_shield.lalum_tenant()`, `allow_binary` defaults to false).
4. Assistant, on "פרוס": deploy `lalum-pipeline` from `main` (`verify_jwt` false), then check `/selftest` and one cockpit chat message. Expected: `last_used_at` is set on the new row.
Rollback: Versions menu of the function back to v24, or redeploy `index.js` from commit `1a8716b`.

## 2. Resend keys and secrets
- `RESEND_API_KEY` was deleted on 2026-10-17 and later restored. A finance test e-mail was delivered on 2026-10-22, so it works. Which key it holds is unknown: no key was created after 2026-10-17 except `supabase-auth-smtp`.
- Readers: `RESEND_API_KEY` feeds `lalum-book`, `lalum-notify`, `lalum-discussion-submit`, `lalum-lead`, `lalum-whatsapp-webhook` and the finance functions (`lalum-fin-doc-send`, `lalum-fin-dunning-send`, `lalum-fin-report-mail`). `RESEND_API_KEY1` feeds `lalum-dispatch-worker` and inbound mail (`lalum-inquiry-email`). Do not delete `RESEND_API_KEY1`.
- Delete an old key only after "Last used" at https://resend.com/api-keys shows it is unused, and only by explicit name from the owner. The Resend account is shared with CoPartners: never touch `copartner-ai`.

## 3. Owner checks
- Intake: one test e-mail to the intake address shown on the cockpit inquiries page; it must appear as an inquiry with the body hidden. Since 2026-10-09 only DMARC reports have arrived.
- Stage 5 on `L-2026-0022`: ZIP export (are originals included), legal hold (deletion must be blocked), permanent deletion (is the original gone from Storage).
- WhatsApp: `matter_alert` is approved (Utility, `he`, one variable: the link) but lives in the "Test WhatsApp Business Account". Confirm which account owns the sender in `WA_NOTIFY_PHONE_ID`; if it is a production account, create the same template there. Do not use `new_matter` (marketing category).
- Supabase advisors: Leaked Password Protection is off; 111 SECURITY DEFINER functions in `public` are callable by authenticated users and need a review (start with admin, bin, export); `pg_net` is in `public`. These are tracked by the security workstream.

## 4. Decisions the owner must take
- Virus scanning for inquiry attachments (until it exists, e-mail attachments are counted, not stored): A. self-hosted ClamAV in the EU or Israel (recommended: client files never reach a third party), or B. a scanning API (needs a sub-processor review).
- Inbound e-mail region: Resend processes lalumapp.com mail in ap-northeast-1 (Tokyo). Accept and disclose it in the privacy text and sub-processor list, or move inbound mail to an EU provider.
- A client name typed into a document's free-text title is not masked.

## 5. pii-gateway source
`pii-gateway` is generated from `@lalum/pii-shield` (`deploy/build.mjs`) and has no address detector. The package source is not in this repository; provide it to align the detectors.

## 6. Projects not started
ClamAV scanning and stored attachments, WhatsApp ingest, website form ingest, automatic sorting of loose files (with human approval), end-to-end permanent deletion test with Storage, legal verification of the cross-border transfer text.

## Lessons
- Never hand-copy a large bundle into a function: deploy the built file and prove it with `/selftest`.
- The deployed function can be older than the repository: after every merge that touches the pipeline, redeploy and run `/selftest`.
- Secret values never pass through chat or a browser agent. A secret is pasted only by the owner, directly into the dashboard.
