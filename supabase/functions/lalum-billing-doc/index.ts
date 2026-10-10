// Edge function: print-ready HTML preview of a pre-bill or a trust deposit receipt.
//   GET /functions/v1/lalum-billing-doc?kind=bill|trust&id=<uuid>[&client=<name>][&court_case=<no>][&bank=<text>]
// The caller's own JWT is used for every read, so the same RLS that guards the tables decides access
// (bills: any firm member; trust ledger: partner, compliance or admin). Client name and court case number are
// not stored by design (matter titles are PII-masked), so the attorney supplies them in the query.
// PDF bytes are produced by lib/services/pdf/render.ts on a Node host: Deno edge cannot launch Chromium.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { preBillHtml, trustReceiptHtml } from '../../../lib/services/pdf/templates.ts';

const HDR = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
};
const err = (status: number, code: string) => new Response(JSON.stringify({ code }), { status, headers: { 'content-type': 'application/json' } });
const date = (s: string) => new Date(s).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return err(405, 'METHOD');
  const auth = req.headers.get('authorization');
  if (!auth) return err(401, 'NO_JWT');
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { authorization: auth } } });
  const q = new URL(req.url).searchParams;
  const kind = q.get('kind'); const id = q.get('id') ?? '';
  if (!UUID.test(id) && !/^\d+$/.test(id)) return err(400, 'BAD_ID');

  if (kind === 'bill') {
    const { data: b } = await sb.from('lalum_matter_bills').select('*').eq('id', id).maybeSingle();
    if (!b) return err(404, 'NOT_FOUND');
    const [{ data: firm }, { data: m }, { data: t }, { data: d }, { data: members }] = await Promise.all([
      sb.from('lalum_firms').select('firm_name,registration_no,email,phone').eq('id', b.firm_id).single(),
      sb.from('lalum_cockpit_matters').select('title').eq('id', b.matter_id).single(),
      sb.from('lalum_time_entries').select('work_date,description,minutes,hourly_rate,amount,user_id').eq('bill_id', id).order('work_date'),
      sb.from('lalum_disbursements').select('incurred_on,kind,description,amount').eq('bill_id', id).order('incurred_on'),
      sb.from('lalum_firm_members').select('user_id,name').eq('firm_id', b.firm_id),
    ]);
    const nameOf = (u: string | null) => (members ?? []).find((x: any) => x.user_id === u)?.name ?? '';
    const lawyers = [...new Set((t ?? []).map((x: any) => nameOf(x.user_id)).filter(Boolean))];
    const html = preBillHtml({
      firm: { name: firm.firm_name, registrationNo: firm.registration_no, email: firm.email, phone: firm.phone },
      billNo: b.bill_no, issuedOn: date(b.finalized_at ?? b.created_at),
      matterTitle: m.title, clientName: q.get('client') ?? '', courtCaseNo: q.get('court_case') ?? undefined, handlingAttorney: lawyers.join(', '),
      time: (t ?? []).map((x: any) => ({ date: x.work_date, description: x.description, lawyer: nameOf(x.user_id), minutes: x.minutes, rate: Number(x.hourly_rate), amount: Number(x.amount) })),
      disbursements: (d ?? []).map((x: any) => ({ date: x.incurred_on, kind: x.kind, description: x.description, amount: Number(x.amount) })),
      vatRate: Number(b.vat_rate), trustApplied: Number(b.trust_applied),
      taxDocRef: b.tax_doc_ref ?? undefined, allocationNumber: b.allocation_number ?? undefined, bankInstructions: q.get('bank') ?? undefined,
    });
    return new Response(html, { headers: HDR });
  }

  if (kind === 'trust') {
    const { data: e } = await sb.from('lalum_trust_ledger_entries').select('*').eq('id', id).eq('entry_type', 'DEPOSIT').maybeSingle();
    if (!e) return err(404, 'NOT_FOUND');
    const [{ data: firm }, { data: m }, { data: acc }] = await Promise.all([
      sb.from('lalum_firms').select('firm_name,registration_no,email,phone').eq('id', e.firm_id).single(),
      sb.from('lalum_cockpit_matters').select('title').eq('id', e.matter_id).single(),
      sb.from('lalum_trust_accounts').select('bank_account').eq('id', e.trust_account_id).single(),
    ]);
    const html = trustReceiptHtml({
      firm: { name: firm.firm_name, registrationNo: firm.registration_no, email: firm.email, phone: firm.phone },
      receiptNo: e.receipt_no, receivedOn: date(e.created_at), depositedBy: e.deposited_by ?? '',
      trustAccount: acc.bank_account, matterTitle: m.title, amount: Number(e.amount), balanceAfter: Number(e.balance_after),
    });
    return new Response(html, { headers: HDR });
  }
  return err(400, 'BAD_KIND');
});
