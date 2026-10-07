# One PII engine: unification plan

Status: PLAN (owner decision: unify). Nothing here is deployed. Redeploying `pii-gateway` needs the owner's explicit approval.
Findings come from a read-only comparison of the two engines on a synthetic Hebrew corpus (see `tests/pii-corpus.test.ts`). The vault, database, audit and HTTP layers of the gateway were judged from source only, not run.

## Finding
- The cockpit engine (`lib/ai/anonymizerProxy.ts`) and the detection inside `pii-gateway` are the same lineage: same regexes, stop list, ID checksum and heuristics. The gateway copy is older.
- The gateway's real value is its wrapper: per-matter vault (AES-256-GCM, wrapped keys, HMAC blind index), hash-chained audit log that refuses PII, per-client auth, restore of tokens in the model's answer, Anthropic-compatible proxy.
- Detection is deterministic on both sides (no model in the loop). Tokens are bare counters (`[KIND_n]`) and do not leak the original.

## Category coverage (D detects, P partial, N no)
| Category | Cockpit | Gateway |
|---|---|---|
| Israeli ID (checksum) | D | D |
| Company number | D (hyphenated form missed) | same |
| Passport | D | N |
| Phone, email, bank account with the word "חשבון", IBAN | D (IBAN typed as bank account) | D (IBAN own kind) |
| Land block and parcel | D | D separate, P combined ("7001/88": the 88 stays) |
| Titled names, names before "ת"ז" | D | D |
| Untitled names | P (declared or seen with a title) | P, better thanks to two-pass learning |
| Company names ("בע"מ") | D | D |
| Street addresses | N | N |
| Amounts, dates, areas, tender numbers | not masked (correct) | not masked (correct) |

## Weak or unsafe behavior (both engines unless noted)
1. The word before "ת"ז" is masked even if it is not a name ("אינו" became a name token): over-masking, utility loss.
2. No address detection, no loose name detection: parties must be declared.
3. Gateway only: the egress guard does not re-check heuristic names.
4. Gateway only: matter-scope learning stores every learned name as `third_party`, losing client / counterparty roles that the conflict engine needs.
5. About 10 percent of random 9-digit numbers pass the ID checksum and are masked.
6. Cockpit only: no restore and no persistence, so a re-visit gets different tokens.

## Decision
Keep ONE detection library, taken from the cockpit engine (passport, combined parcel, longer ID context, full egress guard), inside the gateway's wrapper (matter vault, audit, restore, auth). Do not keep a second vault path.

## Ordered plan
1. Freeze the regression corpus (`tests/pii-corpus.test.ts`, in this PR) and the gateway's current outputs as fixtures.
2. Port the cockpit detectors into `@lalum/pii-shield` and keep the gateway extras (company suffixes, IBAN kind, NER hook).
3. Fix shared defects: hyphenated company number, combined parcel, stop words before "ת"ז", a basic address rule, optional bank account near "סניף/בנק".
4. Map roles once (client, counterparty, third party) so the conflict engine keeps working.
5. Rebuild and redeploy `pii-gateway` to staging first. Needs explicit owner approval.
6. Cockpit and chat both call the gateway with a stable matter id so tokens stay consistent between visits. Retire `anonymizerProxy.ts` and `ephemeralVault.ts` from the request path.
7. Keep a detect-only entry for the conflict engine (entities with offsets, no values).
8. Add tests: corpus round trip, checksum negatives, Hebrew prefixes, token stability across turns, cross-matter isolation, egress guard on heuristic names, loose token restore, tool_use masking, binary rejection, audit refuses PII, no PII in logs.

## Note
`tests/anonymizer.test.ts` uses a real looking mobile number; replace it with an invented one (the legal-engine rules require synthetic data only).
