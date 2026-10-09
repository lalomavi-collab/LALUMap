// Edge function: inbound client e-mail -> firm inquiry inbox (docs/client-inquiry-routing.md, phase 3).
//   POST (Resend webhook "email.received", Svix-signed). verify_jwt is OFF: the signature is the only credential, and the
//   function fails closed without it. Routing: the firm's receiving address inq-<alias>@lalumapp.com .
// Stored: raw text (encrypted in the database by lalum_ingest_inquiry) and the masked text the AI features see.
// Attachments are NOT stored: no scanner is running yet (ClamAV phase); the count is kept and a notice is added to the text.
// Logs: metadata only (counts, outcome). Never an address, subject or body.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Webhook } from 'npm:svix@1.45.1';
import { EphemeralVault } from '../../../lib/crypto/ephemeralVault.ts';
import { LalumAnonymizerProxy } from '../../../lib/ai/anonymizerProxy.ts';
import { aliasFrom, addressOf, bodyText, isAutomated } from '../../../lib/services/inboundEmail.ts';

const sb: any = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SECRET = Deno.env.get('RESEND_INBOUND_WEBHOOK_SECRET') ?? '';
const KEYS = [Deno.env.get('RESEND_RECEIVE_API_KEY'), Deno.env.get('RESEND_API_KEY1'), Deno.env.get('RESEND_API_KEY')].filter((k): k is string => !!k);

const reply = (status: number, code: string): Response =>
  new Response(JSON.stringify({ ok: status < 400, code }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function fetchEmail(id: string): Promise<any | null> {
  for (const key of KEYS) {
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${key}` } });
    if (r.ok) return await r.json();
  }
  return null;
}

// Static synthetic probe: proves the deployed masking code behaves like the repository's (no input from the caller, no data).
const PROBE = 'מר דוד כהן, ת.ז. 123456782, טלפון 052-123-4567, דוא"ל test.person@example.test, ברחוב הרצל 15, חשבון בנק 12-345-678901';

Deno.serve(async (req: Request) => {
  if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/selftest')) {
    const v = await EphemeralVault.create();
    try { return new Response(JSON.stringify({ masked: (await new LalumAnonymizerProxy({ vault: v }).anonymize(PROBE)).masked }), { headers: { 'content-type': 'application/json; charset=utf-8' } }); } finally { v.dispose(); }
  }
  if (req.method !== 'POST') return reply(405, 'METHOD');
  if (!SECRET) return reply(503, 'NOT_CONFIGURED'); // fail closed
  const raw = await req.text();
  let event: any;
  try {
    event = new Webhook(SECRET).verify(raw, {
      'svix-id': req.headers.get('svix-id') ?? '',
      'svix-timestamp': req.headers.get('svix-timestamp') ?? '',
      'svix-signature': req.headers.get('svix-signature') ?? '',
    });
  } catch { return reply(400, 'BAD_SIGNATURE'); }
  if (event?.type !== 'email.received') return reply(200, 'IGNORED_TYPE');

  const d = event.data ?? {};
  const alias = aliasFrom([...(d.to ?? []), ...(d.received_for ?? []), ...(d.cc ?? [])]);
  if (!alias) return reply(200, 'NO_ALIAS');
  const { data: firm } = await sb.rpc('lalum_firm_by_alias', { p_alias: alias });
  if (!firm) return reply(200, 'UNKNOWN_FIRM'); // not told to the sender: no oracle for guessing aliases

  const { data: allowed } = await sb.rpc('lalum_rate_limit', { p_key: `inq-email:${firm}`, p_max: 200, p_window_seconds: 3600 });
  if (allowed === false) return reply(429, 'RATE_LIMITED');

  const claimId = String(d.message_id || d.email_id || '');
  const { data: first, error: claimErr } = await sb.rpc('lalum_inbound_claim', { p_id: claimId });
  if (claimErr) return reply(503, 'CLAIM_FAILED');
  if (first === false) return reply(200, 'DUPLICATE');

  let vault: EphemeralVault | null = null;
  try {
    const mail = await fetchEmail(String(d.email_id ?? ''));
    if (!mail) throw new Error('fetch');
    const sender = addressOf(String(mail.from ?? d.from ?? ''));
    if (!sender) { return reply(200, 'NO_SENDER'); }
    if (isAutomated(sender, mail.headers)) { console.log('inquiry-email skipped automated'); return reply(200, 'AUTOMATED'); }

    const attachments = Array.isArray(d.attachments) ? d.attachments.length : 0;
    const body = bodyText(mail.text, mail.html);
    const subject = String(mail.subject ?? d.subject ?? '').slice(0, 300);
    const rawText = `${subject}\n\n${body}`.trim();
    if (!rawText) { return reply(200, 'EMPTY'); }

    vault = await EphemeralVault.create();
    const shield = new LalumAnonymizerProxy({ vault });
    let masked = (await shield.anonymize(rawText)).masked;
    try { shield.assertClean(masked); } catch { masked = '[הטקסט לא הוסתר בהצלחה ולכן אינו מוצג כאן. פתחו את הטקסט המקורי.]'; }
    if (attachments > 0) masked += `\n[${attachments} קבצים מצורפים לא נשמרו: סריקת וירוסים טרם הופעלה. יש לבקש מהלקוח דרך אחרת.]`;

    const { data, error } = await sb.rpc('lalum_ingest_inquiry', { p_firm: firm, p_channel: 'EMAIL', p_kind: 'EMAIL', p_identity: sender, p_body_raw: rawText, p_body_masked: masked, p_attachments: attachments });
    if (error) throw new Error('ingest');
    const row = Array.isArray(data) ? data[0] : data;
    console.log('inquiry-email stored', JSON.stringify({ routed: !!row?.routed, attachments, chars: rawText.length }));
    return reply(200, 'STORED');
  } catch (e) {
    await sb.rpc('lalum_inbound_release', { p_id: claimId }); // let the provider's retry run
    console.error('inquiry-email error', (e as Error)?.message);
    return reply(503, 'RETRY');
  } finally { vault?.dispose(); }
});
