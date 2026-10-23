import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { preBillHtml, trustReceiptHtml, preBillTotals } from '../lib/services/pdf/templates.ts';
import { LALUM_LOGO_SVG } from '../lib/services/pdf/logo.ts';
import { SAMPLE_BILL, SAMPLE_RECEIPT } from './fixtures/billingSamples.ts';

const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');

test('totals equal lalum_fin_totals (subtotal 2000, VAT 18% = 360, total 2360, due 1360)', () => {
  assert.deepEqual(preBillTotals(SAMPLE_BILL), { subtotal: 2000, vat: 360, total: 2360, balanceDue: 1360 });
});
test('tax-included documents back the VAT out of the line total', () => {
  const t = preBillTotals({ ...SAMPLE_BILL, lines: [{ name: 'x', qty: 1, price: 1180 }], taxIncluded: true, trustApplied: 0 });
  assert.deepEqual(t, { subtotal: 1000, vat: 180, total: 1180, balanceDue: 1180 });
});
test('trust offset above the bill total is refused', () => {
  assert.throws(() => preBillTotals({ ...SAMPLE_BILL, trustApplied: 99999 }));
});
test('pre-bill: not a tax document, trust line, balance due, RTL, allocation wording', () => {
  const h = preBillHtml(SAMPLE_BILL);
  assert.match(h, /<html lang="he" dir="rtl">/);
  assert.match(h, /מסמך זה אינו חשבונית מס/);
  assert.match(h, /קוזז מפיקדון בנאמנות/);
  assert.match(h, /יתרה לתשלום \(Balance Due\)/);
  assert.match(h, /מע״מ \(18%\)/);
  assert.match(h, /תונפק בנפרד ותישא מספר הקצאה/);
  assert.doesNotMatch(h, /מע״מ \(17%\)/);
});
test('pre-bill prints the Invoice4U reference and allocation number only when they exist', () => {
  const h = preBillHtml({ ...SAMPLE_BILL, taxDocRef: '30045', allocationNumber: '123456789' });
  assert.match(h, /חשבונית מס מספר[\s\S]*30045/);
  assert.match(h, /מספר הקצאה:[\s\S]*123456789/);
  assert.doesNotMatch(preBillHtml(SAMPLE_BILL), /מספר הקצאה: <span/);
});
test('trust receipt: separate series, 0 VAT notice, running balance, not a tax document', () => {
  const h = trustReceiptHtml(SAMPLE_RECEIPT);
  assert.match(h, /אישור קבלת כספי פיקדון \/ נאמנות/);
  assert.match(h, /מסמך שאינו מסמך מס/);
  assert.match(h, /TR-000001/);
  assert.match(h, /0\.00 מע״מ, כספי לקוח בנאמנות/);
  assert.match(h, /יתרה צבורה בנאמנות/);
  assert.match(h, /חתימת שותף מנהל/);
});
test('amounts are deterministic and the trust offset keeps its minus sign', () => {
  const h = preBillHtml(SAMPLE_BILL);
  assert.match(h, /-₪1,000\.00/);
  assert.match(h, /₪1,360\.00/);
});
test('user content is escaped', () => {
  const h = preBillHtml({ ...SAMPLE_BILL, customer: { name: '<script>x</script>' } });
  assert.doesNotMatch(h, /<script>x/);
});
test('no dashes used as punctuation in either document (house style)', () => {
  for (const h of [preBillHtml(SAMPLE_BILL), trustReceiptHtml(SAMPLE_RECEIPT)]) {
    const t = text(h);
    assert.doesNotMatch(t, /[–—]/);
    assert.doesNotMatch(t, / - /);
  }
});
test('embedded logo is the approved artwork (public/lalum-logo.svg)', () => {
  assert.equal(LALUM_LOGO_SVG, readFileSync(new URL('../public/lalum-logo.svg', import.meta.url), 'utf8').trim());
  assert.match(preBillHtml(SAMPLE_BILL), /aria-label="LALUM"/);
});

const chromium = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
test('renders both documents to real PDF files', { skip: chromium ? false : 'no Chromium available' }, async () => {
  const { htmlToPdf } = await import('../lib/services/pdf/render.ts');
  for (const html of [preBillHtml(SAMPLE_BILL), trustReceiptHtml(SAMPLE_RECEIPT)]) {
    const pdf = await htmlToPdf(html);
    assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
    assert.ok(pdf.length > 5000);
  }
});
