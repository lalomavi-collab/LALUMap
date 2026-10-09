# Client inquiry routing (design, not built)

Goal: an inquiry from an existing client lands in that client's matter, raises an alert in the cockpit, and every step is recorded with an exact timestamp, including document saves and reads.

Decisions taken (owner, 2026-10-08):
- Channels: inbound WhatsApp, public site form, client portal (signed in), inbound e-mail (Resend receiving is already enabled on lalumapp.com).
- No matching matter: open a matter only when the e-mail has substantive content or attachments; a bare inquiry stays in an unassigned inbox with an alert.
- Alert: in the cockpit itself (the e-mail goes straight into the cockpit), plus the existing generic e-mail/WhatsApp notice that carries no inquiry details.

## 1. Identity matching without cross-client leakage
- Add `lalum_matter_contacts(matter_id, firm_id, kind[EMAIL|PHONE], key_hash)`; `key_hash` = HMAC-SHA256(normalized value, per-firm key from `lalum_firm_conflict_key`). No raw e-mail or phone is stored there.
- An inbound inquiry is hashed the same way and matched inside one firm only. One match: attach. Several matches: do not guess, send to the unassigned inbox with the candidate matters listed to the partner.
- The client portal match is by authenticated user, not by address.

## 2. Storage
- `lalum_matter_inquiries(id, firm_id, matter_id null, channel, received_at timestamptz default now(), body_masked, attachment_count, status[NEW|SEEN|HANDLED], handled_by, handled_at)`.
- Decision (owner, attorney and partner, 2026-10-08): the full inquiry is kept in the matter, raw text included, to make handling efficient and keep everything in the file. Columns: `body_raw` (encrypted at rest with a per-firm key, readable only through an audited RPC) and `body_masked` (what the AI features see; nothing raw ever reaches the gateway or a provider).
- Consequences to close before go-live: the intake notice that says the source is not stored must change; DPA, privacy notice and the security level under Privacy Protection Regulations (Information Security) must reflect raw retention; retention and legal hold apply to inquiries as matter material; no raw text in logs or in the generic notices.
- Attachments are stored as matter documents and counted on the inquiry. Files from unidentified senders are accepted too (decision 2026-10-08), but only after a malware scan: quarantine bucket first, scan, then release to the matter or the unassigned inbox; an infected or unscannable file is rejected and an `INQUIRY_FILE_REJECTED` audit entry is written (count and reason only).
- RLS: firm members of the same firm only; user-scoped clients; service role only inside the ingest functions.

## 3. Audit (hash chain, existing `lalum_append_audit`)
New actions, each with server `now()`, actor, matter, and counts only (no names, no addresses):
`INQUIRY_RECEIVED`, `INQUIRY_ROUTED`, `INQUIRY_UNMATCHED`, `INQUIRY_SEEN`, `INQUIRY_HANDLED`, `INQUIRY_FILE_REJECTED`, `DOC_SAVED`, `DOC_VIEWED`, `DOC_EDITED`, `DOC_EXPORTED`.
- `DOC_VIEWED` and `DOC_SAVED` are written by RPCs the cockpit must call on open and save (a SELECT cannot be audited by a trigger). Reads through other paths are not covered; say so in the UI.

## 4. Alert
- Cockpit subscribes to Supabase Realtime on `lalum_matter_inquiries` (RLS applies). A banner with a counter, and a row marked NEW in the matter list; opening the inquiry writes `INQUIRY_SEEN`.
- Existing outbox gets a generic channel row (no inquiry text), reusing the dispatch worker.

## 5. Ingest functions (verify_jwt off, own secret/signature check, rate limited via `lalum_rate_limit`)
- `lalum-inquiry-email`: Resend inbound webhook (verify signature) -> match -> store -> alert.
- WhatsApp: extend the existing inbound webhook to call the same RPC.
- Site form: extend `lalum-book` / discussion path; portal: authenticated RPC.
- All paths call one SECURITY DEFINER RPC `lalum_ingest_inquiry` so matching, storage and audit live in one place.

## 6. Phases
1. Schema + RPC + audit actions + tests (no UI, no ingest).
2. Cockpit inbox, matter timeline, realtime alert, `DOC_VIEWED`/`DOC_SAVED` calls.
3. Ingest: e-mail, then WhatsApp, then form and portal.
4. Unassigned inbox rules (open a matter only on substantive content or files).

## Risks to settle before phase 1
- Raw retention is decided (see section 2); what remains is the legal text and security level.
- Choose the scanner (ClamAV in a container vs. a scanning API); an API means client files leave our infrastructure and needs the same sub-processor review as any provider.
- Ethics and privacy: a client contacting an address that matches two matters; attachments from unknown senders (malware scanning before storage).
- Legal hold and retention clocks must apply to inquiries as matter material.

## 7. E-mail channel (built)
- Function `lalum-inquiry-email` (verify_jwt off, Svix signature is the credential, fails closed without `RESEND_INBOUND_WEBHOOK_SECRET`). Resend webhook `email.received` -> `https://<project>.supabase.co/functions/v1/lalum-inquiry-email`.
- Routing: each firm has `lalum_firms.inquiry_alias`; the receiving address is `inq-<alias>@lalumapp.com` (shown to members by `lalum_my_inquiry_address()`). Unknown alias is dropped silently (no oracle).
- Idempotency: `lalum_inbound_claim` per message id; released on failure so the provider retries.
- Filters: bounces, auto-replies and bulk mail never become inquiries. Rate limit 200 per firm per hour.
- Text: subject + body, masked with the same anonymizer as the pipeline; raw is encrypted by `lalum_ingest_inquiry`. Masked text that still fails `assertClean` is replaced by a notice.
- Attachments are NOT stored until the scanner exists: the count and a notice are kept. Open: ClamAV phase.
- Processor note: Resend stores and processes inbound mail in its own region (the lalumapp.com domain is in ap-northeast-1). Disclose in the privacy text and sub-processor list before relying on it for client mail.
- `GET .../selftest` masks a fixed synthetic string, to prove the deployed masking code matches the repository.
