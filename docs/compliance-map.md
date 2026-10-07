# LALUMapp compliance map (law firm SaaS)

Status legend: VERIFIED = text read from an official or authoritative publication in this session; TO VERIFY = not yet read from the instrument, do not publish as fact.
Not legal advice. The attorney in charge approves every row before it is relied on or shown to a client.

## 1. Retention of client files

| Requirement | Source | Status | How the system applies it |
|---|---|---|---|
| Archival material kept 7 years from end of handling or end of proceedings (s.90A(b)) | Advocates Law, amendment 42, 2024 (Sefer HaChukim 3161, Knesset PDF) | VERIFIED (text); commencement one year after publication, confirm in force | Matters default to `STATUTORY`: never auto-purged. UI shows retention until end of handling + 7 years. |
| Real estate transaction or proceeding documents: 25 years or another period agreed in writing (Second Schedule, item 3); bills 7 years; foreign-law matters per foreign limitation | Same | VERIFIED (text) | Practice area REAL_ESTATE shows 25 years. Other items shown only as a note; attorney decides. |
| Lawyer and client may agree in writing on another period (s.90A(c)) | Same | VERIFIED (text) | `CLIENT_CONSENT_30D`: partner records the consent date and attests a signed copy exists. |
| Client written consent to destroy 30 days after end of handling, provided the client can ask for the material first | District ethics committee policy 2.003 (25.9.2019), under the older archival rules (1971) | VERIFIED (text); check it still stands after amendment 42 | Purge only when basis is consent AND handling ended 30+ days ago. Tested under rollback. |
| Client may ask for the material during the retention period (s.90A(t)) | Advocates Law amendment 42 | VERIFIED (text) | GAP: no one-click export of all matter documents yet. |
| Destruction secure, per the Privacy Protection Law (s.90A(h)) | Same | VERIFIED (text) | Hard delete from Postgres; audit entry records the count only. Backups retain data until they roll off: GAP to document. |
| Material under another statute's retention duty is outside s.90A (s.90A(yb)(2)) | Same | VERIFIED (text) | Attorney responsibility; noted in the DPA draft. |

## 2. Confidentiality and conflicts

| Requirement | Source | Status | Application |
|---|---|---|---|
| Keep client information secret; staff bound too (rules 19, 20); no use of client information beyond need (rule 21) | Ethics rules 1986 | VERIFIED (text, judgments.org.il copy) | PII masking before any model call; per-firm RLS; platform admin has no read policy on documents. |
| Conflict of interest, current and former clients | Ethics rules 1986 | TO VERIFY (rule numbers) | Per-firm HMAC blind index. Conflict identifiers are NOT auto-purged even for consent matters, so former-client checks keep working. |
| Privilege (s.90 Advocates Law) | Advocates Law | TO VERIFY (text) | Processor acts as the firm's technical arm; DPA draft clause 6. |

## 3. Privacy

| Requirement | Source | Status | Application |
|---|---|---|---|
| Amendment 13 in force 6.8.2025; registration duty narrowed; notice to the Authority if more than 100,000 data subjects of sensitive data; financial sanctions | gov.il Q&A and a law firm summary | VERIFIED (secondary) | Firm is the controller, LALUM the processor (DPA draft). Registration unlikely; confirm. |
| Data security regulations 2017: database definitions document, security procedure | Regulations | TO VERIFY (text) | GAP: provide the firm a template. |
| Privacy officer duty | Amendment 13, s.17B1 | VERIFIED (text of bill) | Categories in the bill do not obviously cover a law firm tool; confirm per firm. |
| Cross-border transfer (Frankfurt hosting, model provider location) | Privacy regulations | TO VERIFY | DPA draft has an open placeholder for the model provider. |

## 4. Engineering gaps to close, in order

1. Export of all matter documents on client request (s.90A(t)).
2. MFA required for partners and admins.
3. Breach notification runbook (the DPA draft has an open hours placeholder).
4. Legal hold flag on a matter: blocks any purge.
5. Backup retention statement (point-in-time recovery window).
6. Hebrew PII detection is rule based and imperfect: keep human review of masked text mandatory.
7. Email carries practice area, risk and conflict status (Resend). Decide whether to make it generic like WhatsApp.
