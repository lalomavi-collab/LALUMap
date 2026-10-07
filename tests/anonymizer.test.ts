import test from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralVault } from '../lib/crypto/ephemeralVault.ts';
import { LalumAnonymizerProxy, isValidIsraeliId } from '../lib/ai/anonymizerProxy.ts';
import { PiiLeakError } from '../lib/ai/types.ts';

const mk = async (parties = [] as any[]) => new LalumAnonymizerProxy({ vault: await EphemeralVault.create(), parties });

test('israeli id checksum', () => {
  assert.equal(isValidIsraeliId('000000018'), true);
  assert.equal(isValidIsraeliId('123456780'), false);
});

test('masks id, company, email, phone, land parcel, bank', async () => {
  const a = await mk();
  const text = 'ת.ז. 000000018, ח.פ. 514000009, דוא"ל dan@example.co.il, טל 052-2490420, גוש 6158 חלקה 25, IL620108000000099999999';
  const r = await a.anonymize(text);
  assert.match(r.masked, /\[ID_NUMBER_1\]/);
  assert.match(r.masked, /\[COMPANY_REG_1\]/);
  assert.match(r.masked, /\[EMAIL_1\]/);
  assert.match(r.masked, /\[PHONE_1\]/);
  assert.match(r.masked, /גוש \[LAND_PARCEL_1\] חלקה \[LAND_PARCEL_2\]/);
  assert.match(r.masked, /\[BANK_ACCOUNT_1\]/);
  for (const raw of ['000000018', '514000009', 'dan@example.co.il', '052-2490420', '6158', 'IL62']) assert.ok(!r.masked.includes(raw), raw);
});

test('same value gets the same token; offsets index the original text', async () => {
  const a = await mk();
  const text = 'ת.ז. 000000018, ושוב 000000018';
  const r = await a.anonymize(text);
  assert.equal(r.masked, 'ת.ז. [ID_NUMBER_1], ושוב [ID_NUMBER_1]');
  for (const e of r.entities) assert.equal(text.slice(e.start, e.end), '000000018');
});

test('declared party names with Hebrew prefixes, titles, and org suffix', async () => {
  const a = await mk([{ name: 'ישראל ישראלי', role: 'CLIENT' }]);
  const r = await a.anonymize('הסכם בין ישראל ישראלי לבין מר דוד כהן ולבין אלפא טכנולוגיות בע"מ. ולישראל ישראלי זכות.');
  assert.ok(!r.masked.includes('ישראלי'));
  assert.ok(!r.masked.includes('כהן'));
  assert.ok(!r.masked.includes('אלפא'));
  assert.equal((r.masked.match(/\[CLIENT_NAME_\d+\]/g) ?? []).length >= 4, true);
});

test('does not mask ordinary numbers or amounts', async () => {
  const a = await mk();
  const r = await a.anonymize('התמורה 1,500,000 ש"ח, בתוך 90 ימים, סעיף 14.');
  assert.equal(r.masked, 'התמורה 1,500,000 ש"ח, בתוך 90 ימים, סעיף 14.');
});

test('renumbering continues above existing tokens', async () => {
  const a = await mk();
  a.reserveFrom('כבר קיים [ID_NUMBER_3] במסמך');
  const r = await a.anonymize('ת.ז. 000000018');
  assert.match(r.masked, /\[ID_NUMBER_4\]/);
});

test('assertClean fails closed on residual PII', async () => {
  const a = await mk();
  assert.throws(() => a.assertClean('צרו קשר: a@b.co'), PiiLeakError);
  assert.doesNotThrow(() => a.assertClean('צרו קשר: [EMAIL_1] וטלפון [PHONE_1]'));
});

test('assertClean also catches a heuristic-only name (title-detected), and honours the allowlist', async () => {
  const a = await mk();
  // "מר דוד כהן" is caught only by the Hebrew-title heuristic, not by structured/dictionary detectors.
  assert.throws(() => a.assertClean('מר דוד כהן חתם על ההסכם'), PiiLeakError);
  // An allowlisted name must not trip the guard (mirrors detect()'s allowlist filter).
  const allowed = new LalumAnonymizerProxy({ vault: await EphemeralVault.create(), allowlist: ['דוד כהן'] });
  assert.doesNotThrow(() => allowed.assertClean('מר דוד כהן חתם על ההסכם'));
});

test('vault seals values and wipes on dispose', async () => {
  const v = await EphemeralVault.create();
  const t = await v.tokenize('ID_NUMBER', '000000018', '000000018');
  assert.equal(await v.reveal(t), '000000018');
  v.dispose();
  assert.equal(v.disposed, true);
  await assert.rejects(() => v.reveal(t));
});
