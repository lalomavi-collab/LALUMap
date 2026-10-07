// Regression corpus for the Hebrew PII engine (synthetic data only: invented names, IDs computed to pass the checksum).
// It pins today's behavior so the planned unification with pii-gateway (docs/pii-engine-unification.md) cannot regress it.
// KNOWN_GAPS are spans the engine does not mask today; the unification should close them, and the test then flips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralVault } from '../lib/crypto/ephemeralVault.ts';
import { LalumAnonymizerProxy, isValidIsraeliId } from '../lib/ai/anonymizerProxy.ts';

const mk = (prefix: string): string => { for (let c = 0; c < 10; c++) { const s = prefix + c; if (isValidIsraeliId(s)) return s; } return ''; };
const id1 = mk('31245678'), id2 = mk('20481537'), id3 = mk('30519846'), co1 = mk('51234567');
const badId = isValidIsraeliId('123456780') ? '123456781' : '123456780';

type Item = { key: string; text: string; mustMask: string[]; knownGaps?: string[] };
const corpus: Item[] = [
  { key: 't1', text: `הלקוח ישראל ישראלי, ת"ז ${id1}, פנה אלינו.`, mustMask: [id1, 'ישראל ישראלי'] },
  { key: 't2', text: `מספר זהות ${id2} של הגב' דנה כהנא.`, mustMask: [id2, 'דנה כהנא'] },
  { key: 't3', text: `${id3} הופיע במסמך ללא הקשר.`, mustMask: [id3] },
  { key: 't4', text: `חברת אלון ובניו בע"מ, ח.פ. ${co1}, חתמה.`, mustMask: ['אלון ובניו בע"מ', co1] },
  { key: 't5', text: 'טלפון 052-1234567 או +972-3-5551234, דוא"ל dana.test@example.co.il.', mustMask: ['052-1234567', '+972-3-5551234', 'dana.test@example.co.il'] },
  { key: 't6', text: 'הנכס בגוש 6123 חלקה 45 תת חלקה 7.', mustMask: ['6123', '45'] },
  { key: 't7', text: 'גוש/חלקה 7001/88 בתל אביב.', mustMask: ['7001', '88'] },
  { key: 't8', text: 'העבירו לחשבון בנק 12-345-678901 בסניף 600.', mustMask: ['12-345-678901'] },
  { key: 't9', text: 'IBAN IL62 0108 0000 0009 9999 999 של החברה.', mustMask: ['0108 0000 0009 9999 999'] },
  { key: 't10', text: 'עו"ד יוסי לוינסון והשמאי רונן אדלר הגישו חוות דעת.', mustMask: ['יוסי לוינסון', 'רונן אדלר'] },
  { key: 't11', text: 'המנוח אברהם בן-דוד ויורשיו, הנתבעת שרה מזרחי טענה.', mustMask: ['אברהם בן-דוד', 'שרה מזרחי'] },
  { key: 't12', text: 'דרכון מספר 12345678 של התובע, ו-Mr. John Smith.', mustMask: ['12345678', 'John Smith'] },
  { key: 't14', text: `כתובת: רחוב הרצל 15, תל אביב. אמר ישראל ישראלי כי ${badId} אינו ת"ז.`, mustMask: [], knownGaps: ['הרצל 15', 'ישראל ישראלי'] },
  { key: 't15', text: `נציג מטעם נדלן פרימיום בע״מ ת.ז. ${id1} ואימייל Info@Test-Firm.com; ח"פ 51-234567-8.`, mustMask: ['נדלן פרימיום בע״מ', id1, 'Info@Test-Firm.com'], knownGaps: ['51-234567-8'] },
];

for (const item of corpus) {
  test(`pii corpus ${item.key}: required spans are masked`, async () => {
    const a = new LalumAnonymizerProxy({ vault: await EphemeralVault.create(), parties: [] });
    const r = await a.anonymize(item.text);
    for (const span of item.mustMask) assert.ok(!r.masked.includes(span), `leaked: ${span}`);
  });
}

test('pii corpus: amounts, areas, dates and tender numbers are not masked (utility)', async () => {
  const a = new LalumAnonymizerProxy({ vault: await EphemeralVault.create(), parties: [] });
  const text = 'מחיר 1,250,000 ש"ח, שטח 85 מ"ר, תאריך 12.03.2025, מספר מכרז 20250123.';
  assert.equal((await a.anonymize(text)).masked, text);
});

test('pii corpus: known gaps are documented (this fails when the engine improves, update KNOWN_GAPS then)', async () => {
  const a = new LalumAnonymizerProxy({ vault: await EphemeralVault.create(), parties: [] });
  const stillLeaking: string[] = [];
  for (const item of corpus) {
    if (!item.knownGaps) continue;
    const r = await a.anonymize(item.text);
    for (const span of item.knownGaps) if (r.masked.includes(span)) stillLeaking.push(span);
  }
  assert.deepEqual(stillLeaking.sort(), ['51-234567-8', 'הרצל 15', 'ישראל ישראלי'].sort());
});
