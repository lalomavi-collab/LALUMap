// lalum-newsletter-subscribe: PUBLIC newsletter signup (LALUMap + lalumapp.com).
// verify_jwt is intentionally false so anonymous visitors can subscribe.
// Mirrors lalum-lead's shape: honeypot, light rate limit, consent recorded
// with the exact wording shown at signup time (Privacy Law Amendment 13).
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://lalumapp.com",
  "https://www.lalumapp.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8080",
];

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  };
}

const clean = (v: unknown, max: number) => (v ?? "").toString().trim().slice(0, max);
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

Deno.serve(async (req: Request) => {
  const CORS = corsFor(req);
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { code: "method_not_allowed" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { code: "bad_json" }); }

  // Honeypot: real users never fill this. Answer 200 so bots learn nothing.
  if (clean(body.company_website, 200)) return json(200, { ok: true });

  const email = clean(body.email, 200).toLowerCase();
  const source = clean(body.source, 60) || "website";
  const consentVersion = clean(body.consent_text_version, 40) || null;
  const consentText = clean(body.consent_text, 1000) || null;

  if (!email || !emailOk(email)) return json(400, { code: "bad_email" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(500, { code: "not_configured" });
  const admin = createClient(url, serviceKey);

  // Light rate limit: same pattern as lalum-lead.
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count: recent } = await admin
    .from("lalum_newsletter_subscribers")
    .select("id", { count: "exact", head: true })
    .gte("consent_at", since)
    .eq("email", email);
  if ((recent ?? 0) >= 3) return json(429, { code: "too_many_requests" });

  // Upsert: a returning or previously-unsubscribed address is reactivated
  // rather than rejected on the unique(email) constraint.
  const { error } = await admin
    .from("lalum_newsletter_subscribers")
    .upsert({
      email,
      status: "active",
      source,
      consent_at: new Date().toISOString(),
      consent_text_version: consentVersion,
      consent_text: consentText,
      unsubscribed_at: null,
    }, { onConflict: "email" })
    .select("id")
    .single();

  if (error) return json(500, { code: "insert_failed" });
  return json(200, { ok: true });
});
