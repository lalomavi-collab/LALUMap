# Handoff: open items (written 2026-10-11)

State in one paragraph: the cockpit work areas, the inbound e-mail channel, the dashboard and the mint theme are merged. The one blocking item is the deployed `lalum-pipeline` (v20): it predates the repository code, so it does not mask street addresses at all. The fixed build exists (`supabase/functions/lalum-pipeline/index.ts`, bundled) and waits for the owner to paste and deploy it.

## 1. Deploy lalum-pipeline (owner action, about five minutes)
1. Open the copy page (private artifact) and press "copy all code".
2. Supabase editor: https://supabase.com/dashboard/project/meoymkcotomoluwlwues/functions/lalum-pipeline/code
3. Click inside the code, Ctrl+A, Ctrl+V, press "Deploy updates".
4. Verify, both URLs must return exactly the same string:
   - https://meoymkcotomoluwlwues.supabase.co/functions/v1/lalum-pipeline/selftest
   - https://meoymkcotomoluwlwues.supabase.co/functions/v1/lalum-inquiry-email/selftest
   - Expected: `{"masked":"מר [CLIENT_NAME_1], ת.ז. [ID_NUMBER_1], טלפון [PHONE_1], דוא\"ל [EMAIL_1], ב[ADDRESS_1], חשבון בנק [BANK_ACCOUNT_1]"}`
5. Upload a synthetic document with "ברחוב הרצל 15" through the cockpit and confirm the address is masked in the matter.
Rollback: Versions menu of the function, back to v20 (identical to what runs today).
Expect: documents that the old, weaker residual check let through can now be rejected with `PII_LEAK_BLOCKED`. That is intended.

## 2. pii-gateway (needs the source)
`pii-gateway` is generated from the `@lalum/pii-shield` package (`deploy/build.mjs`) and has no address detector. Every cockpit chat call passes through it. Fix in the package source (add the prefixed-address rule from `lib/ai/anonymizerProxy.ts`, keep "דרך" without prefix), rebuild, deploy, then check its health URL. The package source is not in this repository: provide it (zip, or add the repository to the session).

## 3. Decisions the owner must take
- Virus scanning for inquiry attachments (until it exists, attachments from e-mail are NOT stored, only counted):
  - A. Self-hosted ClamAV in a small container in the EU or Israel: files stay in our infrastructure; needs hosting and signature updates. Recommended, because client files never reach a third party.
  - B. Scanning API: faster to build, but client files leave our infrastructure and need the same sub-processor review as any provider.
- Inbound e-mail processing region: Resend processes lalumapp.com mail in ap-northeast-1 (Tokyo). Either accept it and disclose it in the privacy text and sub-processor list, or move inbound mail to a provider in the EU.
- Replace the old full-access Resend key (`RESEND_API_KEY`) with the restricted one and delete the unused keys: https://resend.com/api-keys , then the secret: https://supabase.com/dashboard/project/meoymkcotomoluwlwues/functions/secrets
- Approve the `matter_alert` WhatsApp template (Pending) in WhatsApp Manager.

## 4. After step 1 (assistant)
Remove or protect `/selftest`; replace the service-role key used between lalum-pipeline and pii-gateway with a dedicated shared secret; test an e-mail with an attachment (expected: inquiry stored, notice that files were not kept).

## 5. Projects not started
ClamAV scanning and stored attachments, WhatsApp ingest, website form ingest, automatic sorting of loose files (with human approval), end-to-end permanent deletion test with Storage, ZIP export including originals, legal verification of the cross-border transfer text.

## Lessons
- Never hand-copy a large bundle into a function: the owner pastes the built file and the `/selftest` string proves the masking code.
- The deployed function can be older than the repository: after every merge that touches `lib/ai`, redeploy and run `/selftest`.
