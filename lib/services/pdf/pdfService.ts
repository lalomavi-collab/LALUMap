// Node-side PDF endpoint logic. The caller's JWT is forwarded to the lalum-billing-doc edge function, so the
// database's RLS (not this service) decides who may see a bill or a trust receipt. Nothing is cached or stored.
export interface PdfDeps {
  edgeBase: string;                       // e.g. https://<ref>.supabase.co/functions/v1
  anonKey: string;
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;
  render: (html: string) => Promise<Uint8Array>;
}
export interface PdfReply { status: number; headers: Record<string, string>; body: Uint8Array | string }

const FORWARD = ['kind', 'id', 'client', 'court_case', 'bank'] as const;
const json = (status: number, code: string): PdfReply => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
const SAFE = /^[0-9a-f-]{1,40}$/i;

export async function handlePdfRequest(url: string, authorization: string | undefined, deps: PdfDeps): Promise<PdfReply> {
  const u = new URL(url, 'http://localhost');
  if (u.pathname !== '/pdf') return json(404, 'NOT_FOUND');
  if (!authorization?.startsWith('Bearer ')) return json(401, 'NO_JWT');
  const kind = u.searchParams.get('kind'); const id = u.searchParams.get('id') ?? '';
  if (kind !== 'bill' && kind !== 'trust') return json(400, 'BAD_KIND');
  if (!SAFE.test(id)) return json(400, 'BAD_ID');
  const q = new URLSearchParams();
  for (const k of FORWARD) { const v = u.searchParams.get(k); if (v !== null) q.set(k, v.slice(0, 300)); }
  const r = await deps.fetchImpl(`${deps.edgeBase}/lalum-billing-doc?${q}`, { headers: { authorization, apikey: deps.anonKey } });
  if (r.status !== 200) return json(r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 502, 'UPSTREAM');
  const pdf = await deps.render(await r.text());
  const name = kind === 'bill' ? 'pre-bill' : 'trust-receipt';
  return { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${name}-${id.slice(0, 8)}.pdf"`, 'cache-control': 'no-store' }, body: pdf };
}
