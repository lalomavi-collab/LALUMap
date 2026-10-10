# pii-gateway unification patch

Status: cockpit engine (`lib/ai/anonymizerProxy.ts`) is fixed and tested. The deployed `pii-gateway` v13 is NOT redeployed: it is a generated bundle of `@lalum/pii-shield`, and the package source is not in this repo. Hand-editing the 40KB bundle risks transcription errors and there is no staging function.

Reference implementation of the patch: `tests/fixtures/pii-gateway-patched-detectors.mjs` (diff against `pii-gateway-v13-detectors.mjs`, every change marked `PATCH`). `tests/pii-parity.test.ts` proves it closes the gaps and matches the cockpit.

## Changes to apply in `@lalum/pii-shield`, then rebuild with `deploy/build.mjs`

1. EMAIL: first character must be alphanumeric (`[A-Za-z0-9][A-Za-z0-9._%+\-]*@...`).
2. numRe: add `\d{2,3}-\d{6,7}-\d` before `\d{2,8}-\d` (hyphenated company number, e.g. 51-234567-8).
3. Passport rule: `(passport|דרכון)(\s+(no|number|מס'|מספר))?\s*[:.]?\s*([A-Z]{0,2}\d{6,9})` -> ID_NUMBER, only the number.
4. Combined parcel `גוש/חלקה|גו"ח` followed by `N/M`: two tokens (GUSH, HELKA).
5. Street address rule: street word (רחוב, רח', שדרות, שד', דרך, סמטת, כיכר; one or two prefix letters allowed before all but דרך, kept outside the span) + 1-3 words + house number -> new kind ADDRESS (add to token kinds and restore map).
6. STOP words: add אינו אינה אינם אינן הינם הינן so the word before "ת"ז" is not read as a name.
7. Egress guard `residual`: include `detectHeuristicPersons` (v13 checks structured + dictionary only, so a heuristic name can leave the gateway unmasked).

## Known gap (both engines)

Untitled personal names ("ישראל ישראלי" with no title, no ת"ז anchor, not declared) are not detected. Mitigation stays the declared-parties dictionary.

## Rollout

Rebuild, deploy as a new version, run the cockpit corpus against it, keep v13 as rollback. Needs approval and the package source.
