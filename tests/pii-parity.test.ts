// Parity: the cockpit engine must close the gaps the same way the patched gateway does, and the patch must be a strict improvement over deployed v13.
// Fixtures hold detector code only; all data below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralVault } from '../lib/crypto/ephemeralVault.ts';
import { LalumAnonymizerProxy, isValidIsraeliId } from '../lib/ai/anonymizerProxy.ts';
// @ts-expect-error untyped .mjs fixtures
import * as V13 from './fixtures/pii-gateway-v13-detectors.mjs';
// @ts-expect-error untyped .mjs fixtures
import * as PATCHED from './fixtures/pii-gateway-patched-detectors.mjs';

const mk = (p: string): string => { for (let c = 0; c < 10; c++) { const s = p + c; if (isValidIsraeliId(s)) return s; } return ''; };
const id1 = mk('31245678');
const bad = isValidIsraeliId('123456780') ? '123456781' : '123456780';
const cases: Array<[string, string, string[]]> = [
  ['email-first-char', 'אימייל Info@Test-Firm.com ו-_x@test.com', ['Info@Test-Firm.com']],
  ['hyphen-company', 'ח"פ 51-234567-8.', ['51-234567-8']],
  ['passport', 'דרכון מספר 12345678 של התובע.', ['12345678']],
  ['combined-parcel', 'גוש/חלקה 7001/88 בתל אביב.', ['7001', '88']],
  ['address', 'כתובת: רחוב הרצל 15, תל אביב.', ['הרצל 15']],
  ['address-prefix-b', 'שיחה בעניין חוזה שכירות ברחוב הרצל 15.', ['הרצל 15']],
  ['address-prefix-l', 'הדירה לרחוב ביאליק 3 ולשדרות רוטשילד 22.', ['ביאליק 3', 'רוטשילד 22']],
  ['address-adjacent-name', 'מר דוד לוי ברחוב הרצל 12 הגיש בקשה.', ['הרצל 12', 'דוד לוי']],
  ['word-before-tz', `אמר אדם כי ${bad} אינו ת"ז.`, []],
  ['plain', `הלקוח דנה כהנא, ת"ז ${id1}.`, [id1]],
];

for (const [key, text, must] of cases) {
  test(`parity ${key}: patched gateway and cockpit mask the same required spans`, async () => {
    const a = new LalumAnonymizerProxy({ vault: await EphemeralVault.create(), parties: [] });
    const cockpit = (await a.anonymize(text)).masked;
    const patched = PATCHED.mask(text) as string;
    for (const span of must) {
      assert.ok(!cockpit.includes(span), `cockpit leaked ${span}`);
      assert.ok(!patched.includes(span), `patched gateway leaked ${span}`);
    }
  });
}

test('patch is a strict improvement: v13 leaks at least these, patched leaks none', () => {
  const leaksV13: string[] = [], leaksPatched: string[] = [];
  for (const [, text, must] of cases) {
    const m13 = V13.mask(text) as string, mp = PATCHED.mask(text) as string;
    for (const s of must) { if (m13.includes(s)) leaksV13.push(s); if (mp.includes(s)) leaksPatched.push(s); }
  }
  assert.deepEqual(leaksPatched, []);
  assert.ok(leaksV13.length >= 4, `expected v13 gaps, got ${JSON.stringify(leaksV13)}`);
});

test('patched egress guard flags a heuristic name that structured-only v13 guard misses', () => {
  const t = 'עו"ד יוסי לוינסון הגיש חוות דעת.';
  assert.equal(V13.residual(t).length, 0);
  assert.ok(PATCHED.residual(t).length > 0);
});
