// lalum-dispatch-worker: delivers the cockpit's partner notifications.
// Drains public.lalum_dispatch_outbox (written by lalum_provision_matter) and sends
//   EMAIL      -> the partner, through Resend (same secrets as lalum-notify)
//   ADMIN_COPY -> the firm's control inbox (LALUM_NOTIFY_TO)
//   WHATSAPP   -> the partner's phone, WhatsApp Cloud API (same secrets as lalum-whatsapp-webhook)
// Invoked every minute by pg_cron (job "lalum-dispatch-worker"); authenticated by the
// x-lalum-worker header, checked in Postgres against lalum_private.worker_keys. verify_jwt is off.
//
// Messages carry NO matter details on any channel (e-mail transits Resend, WhatsApp transits Meta):
// only a generic line and a link that requires login. Practice area, risk level and conflict status are
// visible only after signing in. No title, names or document text ever leaves.
//
// WhatsApp note:  Rules: a business may send free text only inside 24h of the recipient's last message to
// the business. Outside it, Meta requires an approved template. Set WA_NOTIFY_TEMPLATE (a UTILITY template
// with ONE body variable, the link, and fixed text after it; language WA_NOTIFY_TEMPLATE_LANG, default "he")
// to enable that path. Without it, an out-of-window WhatsApp is marked SKIPPED, not retried forever.
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE = "https://lalumapp.com";
const sb: any = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// RESEND_API_KEY1 is the key scoped to lalumapp.com; falls back to the shared RESEND_API_KEY.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY1") ?? Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("LALUM_FROM_EMAIL") ?? "LALUM <no-reply@lalumapp.com>";
const NOTIFY_TO = Deno.env.get("LALUM_NOTIFY_TO") ?? "avraham@lalum.co";
// Dedicated WA_NOTIFY_* secrets win, so the notifier can use its own number without repointing the inbound bot
// (lalum-whatsapp-webhook reads WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).
const WA_TOKEN = Deno.env.get("WA_NOTIFY_TOKEN") ?? Deno.env.get("WHATSAPP_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WA_NOTIFY_PHONE_ID") ?? Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const WA_TEMPLATE = Deno.env.get("WA_NOTIFY_TEMPLATE") ?? Deno.env.get("WHATSAPP_TEMPLATE_NEW_MATTER") ?? "";
const WA_LANG = Deno.env.get("WA_NOTIFY_TEMPLATE_LANG") ?? Deno.env.get("WHATSAPP_TEMPLATE_LANG") ?? "he";


interface Row { id: string; channel: string; matter_id: string; payload: Record<string, unknown>; attempts: number; recipient_email: string | null; recipient_phone: string | null; firm_name: string | null }
type Outcome = { result: "SENT" | "SKIPPED" | "RETRY"; error?: string };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function content(r: Row) {
  const link = `${SITE}/workspace?matter=${r.matter_id}`; // built from the row's own id, never from payload text
  const admin = r.channel === "ADMIN_COPY";
  const subject = admin ? "עותק ביקורת: תיק חדש נקלט" : "תיק חדש ממתין לבדיקתך";
  const lines = [admin ? "עותק ביקורת לניהול: נקלט תיק חדש." : "נקלט תיק חדש וממתין לבדיקתך."];
  const text = `${lines.join("\n")}\n${link}\nההודעה אינה כוללת פרטי תיק. הכניסה דורשת התחברות.`;
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.7;color:#1a1815">` +
    lines.map((l) => `<p style="margin:0 0 6px">${esc(l)}</p>`).join("") +
    `<p><a href="${link}" style="background:#537056;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none">פתיחת התיק</a></p>` +
    `<p style="color:#86807a;font-size:12px">ההודעה אינה כוללת פרטי תיק. הכניסה דורשת התחברות.</p></div>`;
  return { subject, text, html, link };
}

async function sendEmail(to: string, c: ReturnType<typeof content>): Promise<Outcome> {
  if (!RESEND_API_KEY) return { result: "RETRY", error: "RESEND_API_KEY missing" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject: c.subject, html: c.html, text: c.text }),
    });
    if (res.ok) return { result: "SENT" };
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? { result: "SKIPPED", error: `resend ${res.status}` } : { result: "RETRY", error: `resend ${res.status}` };
  } catch (e) {
    return { result: "RETRY", error: `resend network ${String((e as Error).name)}` };
  }
}

async function waPost(body: unknown): Promise<{ ok: boolean; status: number; code?: number }> {
  const res = await fetch(`https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, status: res.status };
  let code: number | undefined;
  try { code = (await res.json())?.error?.code; } catch { /* non JSON */ }
  return { ok: false, status: res.status, code };
}

async function sendWhatsApp(phone: string | null, c: ReturnType<typeof content>): Promise<Outcome> {
  if (!phone) return { result: "SKIPPED", error: "NO_PHONE" };
  if (!WA_TOKEN || !WA_PHONE_ID) return { result: "SKIPPED", error: "WHATSAPP_NOT_CONFIGURED" };
  try {
    // 1) free text, valid only inside the 24h window
    const t = await waPost({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: `נקלט תיק חדש ומחכה לבדיקתך.\n${c.link}` } });
    if (t.ok) return { result: "SENT" };
    if (t.code !== 131047) return t.status >= 500 || t.status === 429 ? { result: "RETRY", error: `wa ${t.status}` } : { result: "SKIPPED", error: `wa ${t.status}/${t.code ?? ""}` };
    // 2) outside the window: approved template, if one is configured
    if (!WA_TEMPLATE) return { result: "SKIPPED", error: "NEEDS_TEMPLATE_OR_24H_WINDOW" };
    const tpl = await waPost({
      messaging_product: "whatsapp", to: phone, type: "template",
      template: { name: WA_TEMPLATE, language: { code: WA_LANG }, components: [{ type: "body", parameters: [c.link].map((text) => ({ type: "text", text })) }] },
    });
    if (tpl.ok) return { result: "SENT" };
    return tpl.status >= 500 || tpl.status === 429 ? { result: "RETRY", error: `wa tpl ${tpl.status}` } : { result: "SKIPPED", error: `wa tpl ${tpl.status}/${tpl.code ?? ""}` };
  } catch (e) {
    return { result: "RETRY", error: `wa network ${String((e as Error).name)}` };
  }
}

async function deliver(r: Row): Promise<Outcome> {
  const c = content(r);
  if (r.channel === "EMAIL") return r.recipient_email ? sendEmail(r.recipient_email, c) : { result: "SKIPPED", error: "NO_EMAIL" };
  if (r.channel === "ADMIN_COPY") return sendEmail(NOTIFY_TO, c);
  if (r.channel === "WHATSAPP") return sendWhatsApp(r.recipient_phone, c);
  return { result: "SKIPPED", error: "UNKNOWN_CHANNEL" };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const key = req.headers.get("x-lalum-worker") ?? "";
  const { data: ok } = await sb.rpc("lalum_verify_worker_key", { p_key: key });
  if (ok !== true) return new Response("unauthorized", { status: 401 });

  const { data: rows, error } = await sb.rpc("lalum_claim_outbox", { p_limit: 20 });
  if (error) { console.error("lalum-dispatch-worker: claim failed"); return Response.json({ ok: false }, { status: 503 }); }
  const tally: Record<string, number> = {};
  for (const r of (rows ?? []) as Row[]) {
    let out: Outcome;
    try { out = await deliver(r); } catch { out = { result: "RETRY", error: "UNEXPECTED" }; }
    await sb.rpc("lalum_finish_outbox", { p_id: r.id, p_result: out.result, p_error: out.error ?? null });
    tally[`${r.channel}:${out.result}`] = (tally[`${r.channel}:${out.result}`] ?? 0) + 1;
  }
  return Response.json({ ok: true, claimed: (rows ?? []).length, tally });
});
