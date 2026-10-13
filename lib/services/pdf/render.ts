// HTML to PDF via headless Chromium (playwright-core). Chromium shapes Hebrew and bidi text correctly,
// which pure-JS PDF writers do not. Needs a Node host: Supabase Edge (Deno) cannot launch a browser,
// so the edge function serves the HTML preview and this renderer produces the PDF file.
import { existsSync } from 'node:fs';

function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const p of [`${base}/chromium`, `${base}/chromium-1194/chrome-linux/chrome`]) if (existsSync(p)) return p;
  return undefined;
}

export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
