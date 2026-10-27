// lalum-newsletter-daily: sends ONE queued newsletter update to every active
// subscriber. Invoked by pg_cron (the ?k= key lives in lalum_private.report_keys and is
// checked through lalum_verify_report_key, same as lalum-daily-report) or manually for a one-off send.
//
// SAFETY GATE: this function sends nothing on its own. It only ever sends a
// content row that a human already set to status='approved' in
// public.lalum_newsletter_updates. No draft is ever auto-approved, and if the
// queue is empty this is a silent no-op (ok:true, skipped:"no_content_queued").
// That gate is intentional: content quality and Israeli anti-spam compliance
// (Privacy Law Amendment 13) need a human sign-off before real mail goes out.
import { createClient } from "jsr:@supabase/supabase-js@2";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: keyOk } = await supa.rpc("lalum_verify_report_key", { p_key: url.searchParams.get("k") ?? "" });
  if (keyOk !== true) {
    return new Response("forbidden", { status: 403 });
  }

  // Pick the oldest approved, unsent update.
  const { data: queued, error: qErr } = await supa
    .from("lalum_newsletter_updates")
    .select("id, title, body")
    .eq("status", "approved")
    .is("sent_at", null)
    .order("scheduled_for", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (qErr) return new Response(JSON.stringify({ ok: false, code: "query_failed", detail: qErr.message }), { status: 500 });
  if (!queued) return new Response(JSON.stringify({ ok: true, skipped: "no_content_queued" }), { status: 200, headers: { "content-type": "application/json" } });

  // Claim it: flip approved -> sending, conditioned on it still being
  // 'approved'. If a concurrent invocation already claimed it, back off.
  const { data: claimed, error: claimErr } = await supa
    .from("lalum_newsletter_updates")
    .update({ status: "sending" })
    .eq("id", queued.id)
    .eq("status", "approved")
    .select("id")
    .maybeSingle();
  if (claimErr || !claimed) {
    return new Response(JSON.stringify({ ok: true, skipped: "already_claimed" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("LALUM_FROM_EMAIL") ?? "LALUM <no-reply@lalumapp.com>";
  const siteUrl = Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".supabase.co/functions/v1");

  if (!apiKey) {
    // Nothing sent: release the claim so a correctly-configured retry can send.
    await supa.from("lalum_newsletter_updates").update({ status: "approved" }).eq("id", queued.id);
    return new Response(JSON.stringify({ ok: false, code: "resend_not_configured" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const { data: subs, error: sErr } = await supa
    .from("lalum_newsletter_subscribers")
    .select("email, unsubscribe_token")
    .eq("status", "active");
  if (sErr) {
    await supa.from("lalum_newsletter_updates").update({ status: "approved" }).eq("id", queued.id);
    return new Response(JSON.stringify({ ok: false, code: "subscribers_query_failed" }), { status: 500 });
  }
  if (!subs || subs.length === 0) {
    await supa.from("lalum_newsletter_updates").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", queued.id);
    return new Response(JSON.stringify({ ok: true, skipped: "no_active_subscribers" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const bodyHtml = esc(queued.body).replace(/\n/g, "<br>");
  const errors: string[] = [];
  let sent = 0;

  // Resend's batch endpoint accepts up to 100 messages per call; each
  // recipient gets their own personalised unsubscribe link.
  const CHUNK = 90;
  for (let i = 0; i < subs.length; i += CHUNK) {
    const chunk = subs.slice(i, i + CHUNK);
    const payload = chunk.map((s) => ({
      from,
      to: s.email,
      subject: queued.title,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;text-align:right;color:#1a1815;max-width:520px;margin:0 auto;">` +
        `<h2 style="font-family:Georgia,serif;">${esc(queued.title)}</h2>` +
        `<p style="line-height:1.7;">${bodyHtml}</p>` +
        `<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">` +
        `<p style="color:#86807a;font-size:12px;">` +
        `<a href="${siteUrl}/lalum-newsletter-unsubscribe?t=${s.unsubscribe_token}" style="color:#86807a;">להסרה מרשימת התפוצה</a>` +
        `</p></div>`,
    }));
    try {
      const r = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.ok) sent += chunk.length;
      else errors.push(`resend_${r.status}_at_${i}`);
    } catch {
      errors.push(`resend_exception_at_${i}`);
    }
  }

  await supa.from("lalum_newsletter_updates").update({
    status: "sent",
    sent_at: new Date().toISOString(),
  }).eq("id", queued.id);

  await supa.from("lalum_newsletter_subscribers")
    .update({ last_sent_at: new Date().toISOString() })
    .eq("status", "active");

  return new Response(JSON.stringify({ ok: errors.length === 0, sent, total: subs.length, errors }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
