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
- Body goes through the PII gateway first; only the masked text is stored. Open decision: whether the raw text may be retained at all (current promise to users: the source is not stored). Default here: not retained.
- Attachments are stored as matter documents (anonymized, same as intake) and counted on the inquiry.
- RLS: firm members of the same firm only; user-scoped clients; service role only inside the ingest functions.

## 3. Audit (hash chain, existing `lalum_append_audit`)
New actions, each with server `now()`, actor, matter, and counts only (no names, no addresses):
`INQUIRY_RECEIVED`, `INQUIRY_ROUTED`, `INQUIRY_UNMATCHED`, `INQUIRY_SEEN`, `INQUIRY_HANDLED`, `DOC_SAVED`, `DOC_VIEWED`, `DOC_EDITED`, `DOC_EXPORTED`.
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
- Raw inquiry text retention vs. the "source not stored" promise.
- Ethics and privacy: a client contacting an address that matches two matters; attachments from unknown senders (malware scanning before storage).
- Legal hold and retention clocks must apply to inquiries as matter material.
