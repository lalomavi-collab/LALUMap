// Edge function: print-ready HTML preview of a pre-bill (PROFORMA) or a trust deposit receipt, built on the
// existing finance ledger (lalum_fin_documents, lalum_fin_customers) and trust ledger (lalum_trust_ledger).
//   GET /functions/v1/lalum-billing-doc?kind=bill&id=<fin document uuid>[&court_case=..&attorney=..&bank=..]
//   GET /functions/v1/lalum-billing-doc?kind=trust&id=<trust ledger id>
// Every read uses the caller's own JWT, so RLS (lalum_fin_can) decides access. A legal tax invoice (INVOICE) is
// never rendered here: Invoice4U owns it, the response points at its pdf_url instead.
// PDF bytes come from lib/services/pdf/render.ts on a Node host; Deno edge cannot launch Chromium.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { preBillHtml, trustReceiptHtml } from '../../../lib/services/pdf/templates.ts';

const HDR = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
};
const err = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, ...extra }), { status, headers: { 'content-type': 'application/json' } });
const date = (s: string) => new Date(s).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return err(405, 'METHOD');
  const auth = req.headers.get('authorization');
  if (!auth) return err(401, 'NO_JWT');
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { authorization: auth } } });
  const q = new URL(req.url).searchParams;
  const kind = q.get('kind'); const id = q.get('id') ?? '';
  const firmOf = async (firmId: string) => {
    const { data: f } = await sb.from('lalum_firms').select('firm_name,registration_no,email,phone').eq('id', firmId).single();
    return { name: f.firm_name, registrationNo: f.registration_no, email: f.email, phone: f.phone };
  };

  if (kind === 'bill') {
    if (!UUID.test(id)) return err(400, 'BAD_ID');
    const { data: d } = await sb.from('lalum_fin_documents').select('*').eq('id', id).maybeSingle();
    if (!d) return err(404, 'NOT_FOUND');
    if (d.doc_type !== 'PROFORMA') return err(409, 'NOT_A_PRE_BILL', { doc_type: d.doc_type, pdf_url: d.pdf_url ?? null });
    const [firm, { data: c }, { data: link }, { data: tr }] = await Promise.all([
      firmOf(d.firm_id),
      sb.from('lalum_fin_customers').select('name,tax_id,address,city').eq('id', d.customer_id).single(),
      sb.from('lalum_fin_document_matters').select('matter_id').eq('document_id', id).limit(1),
      sb.from('lalum_trust_ledger').select('amount').eq('reference_doc_id', id).in('tx_type', ['EARNED_FEE_TRANSFER', 'REVERSAL']),
    ]);
    const trustApplied = -(tr ?? []).reduce((a: number, r: any) => a + Number(r.amount), 0);
    const matterId = link?.[0]?.matter_id;
    const { data: m } = matterId ? await sb.from('lalum_cockpit_matters').select('title').eq('id', matterId).maybeSingle() : { data: null };
    const html = preBillHtml({
      firm, docRef: d.doc_number ? String(d.doc_number) : `טיוטה ${id.slice(0, 8)}`, issuedOn: date(d.issue_date), dueOn: d.due_date ? date(d.due_date) : undefined,
      subject: d.subject || undefined,
      customer: { name: c.name, taxId: c.tax_id ?? undefined, address: [c.address, c.city].filter(Boolean).join(', ') || undefined },
      matterTitle: m?.title, courtCaseNo: q.get('court_case') ?? undefined, handlingAttorney: q.get('attorney') ?? undefined,
      lines: d.lines, taxIncluded: d.tax_included, vatRatePct: Number(d.vat_rate), trustApplied: Math.max(0, trustApplied),
      bankInstructions: q.get('bank') ?? undefined,
    });
    return new Response(html, { headers: HDR });
  }

  if (kind === 'trust') {
    if (!/^\d{1,18}$/.test(id)) return err(400, 'BAD_ID');
    const { data: e } = await sb.from('lalum_trust_ledger').select('*').eq('id', id).eq('tx_type', 'DEPOSIT').maybeSingle();
    if (!e) return err(404, 'NOT_FOUND');
    const [firm, { data: acc }, { data: m }, { data: run }] = await Promise.all([
      firmOf(e.firm_id),
      sb.from('lalum_trust_accounts').select('bank_name,branch,account_number').eq('id', e.trust_account_id).single(),
      sb.from('lalum_cockpit_matters').select('title').eq('id', e.matter_id).maybeSingle(),
      sb.from('lalum_trust_ledger').select('amount').eq('matter_id', e.matter_id).lte('id', e.id),
    ]);
    const balanceAfter = (run ?? []).reduce((a: number, r: any) => a + Number(r.amount), 0);
    const html = trustReceiptHtml({
      firm, receiptNo: e.receipt_no, receivedOn: date(e.created_at), depositedBy: e.counterparty ?? '',
      trustAccount: [acc.bank_name, acc.branch, acc.account_number].filter(Boolean).join(' / '),
      matterTitle: m?.title ?? '', amount: Number(e.amount), balanceAfter,
    });
    return new Response(html, { headers: HDR });
  }
  return err(400, 'BAD_KIND');
});
