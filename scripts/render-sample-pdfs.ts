// Renders the two sample documents to out/pdf/*.pdf and *.html. Run: node scripts/render-sample-pdfs.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { preBillHtml, trustReceiptHtml } from '../lib/services/pdf/templates.ts';
import { htmlToPdf } from '../lib/services/pdf/render.ts';
import { SAMPLE_BILL, SAMPLE_RECEIPT } from '../tests/fixtures/billingSamples.ts';

mkdirSync('out/pdf', { recursive: true });
for (const [name, html] of [['pre-bill', preBillHtml(SAMPLE_BILL)], ['trust-receipt', trustReceiptHtml(SAMPLE_RECEIPT)]] as const) {
  writeFileSync(`out/pdf/${name}.html`, html);
  writeFileSync(`out/pdf/${name}.pdf`, await htmlToPdf(html));
  console.log(`out/pdf/${name}.pdf`);
}
