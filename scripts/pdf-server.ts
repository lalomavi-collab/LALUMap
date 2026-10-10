// Minimal Node host for PDF downloads. Env: SUPABASE_URL, SUPABASE_ANON_KEY, PORT (default 8787).
// GET /pdf?kind=bill|trust&id=<fin document uuid or trust ledger id>[&court_case=..&attorney=..&bank=..]   Authorization: Bearer <user JWT>
import { createServer } from 'node:http';
import { handlePdfRequest } from '../lib/services/pdf/pdfService.ts';
import { htmlToPdf } from '../lib/services/pdf/render.ts';

const base = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
if (!base || !anon) { console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required'); process.exit(1); }
const deps = {
  edgeBase: `${base.replace(/\/$/, '')}/functions/v1`, anonKey: anon, render: htmlToPdf,
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => fetch(url, init),
};
createServer(async (req, res) => {
  try {
    const r = await handlePdfRequest(req.url ?? '/', req.headers.authorization, deps);
    res.writeHead(r.status, r.headers).end(r.body);
  } catch { res.writeHead(500, { 'content-type': 'application/json' }).end('{"code":"ERROR"}'); }
}).listen(Number(process.env.PORT ?? 8787));
