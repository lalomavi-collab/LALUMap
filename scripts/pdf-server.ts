// Minimal Node host for PDF downloads. Env: SUPABASE_URL, SUPABASE_ANON_KEY, PORT (default 8787).
// GET /pdf?kind=bill|trust&id=<fin document uuid or trust ledger id>[&court_case=..&attorney=..&bank=..]   Authorization: Bearer <user JWT>
// GET /healthz  -> 200 {"ok":true} (no auth, no data)
import { createServer } from 'node:http';
import { handlePdfRequest } from '../lib/services/pdf/pdfService.ts';
import { htmlToPdf } from '../lib/services/pdf/render.ts';

const base = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
if (!base || !anon) { console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required'); process.exit(1); }
const MAX_CONCURRENT = 2;   // each render launches a browser: bound memory
let active = 0;
const deps = {
  edgeBase: `${base.replace(/\/$/, '')}/functions/v1`, anonKey: anon, render: htmlToPdf,
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
};
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
createServer(async (req, res) => {
  if (req.url === '/healthz') return void res.writeHead(200, { ...SEC, 'content-type': 'application/json' }).end('{"ok":true}');
  if (active >= MAX_CONCURRENT) return void res.writeHead(503, { ...SEC, 'content-type': 'application/json', 'retry-after': '5' }).end('{"code":"BUSY"}');
  active++;
  try {
    const r = await handlePdfRequest(req.url ?? '/', req.headers.authorization, deps);
    res.writeHead(r.status, { ...SEC, ...r.headers }).end(r.body);
  } catch { res.writeHead(500, { ...SEC, 'content-type': 'application/json' }).end('{"code":"ERROR"}'); }
  finally { active--; }
}).listen(Number(process.env.PORT ?? 8787), () => console.log(`pdf server on ${process.env.PORT ?? 8787}`));
