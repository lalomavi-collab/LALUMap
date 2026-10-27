// lalum-newsletter-unsubscribe: PUBLIC one-click unsubscribe landing page.
// GET /lalum-newsletter-unsubscribe?t=<unsubscribe_token>
// Always returns a plain HTML page (this is opened directly from an email
// link, not called via fetch), in Hebrew, confirming the outcome.
import { createClient } from "jsr:@supabase/supabase-js@2";

function page(title: string, message: string): Response {
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#F5F1E8;` +
    `color:#1A1815;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}` +
    `.card{background:#fff;border-radius:18px;padding:32px;max-width:420px;text-align:center;` +
    `box-shadow:0 1px 3px rgba(26,24,21,.08);}h1{font-size:20px;margin:0 0 12px;}` +
    `p{color:rgba(26,24,21,.7);line-height:1.6;margin:0;}</style></head><body>` +
    `<div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req: Request) => {
  const token = new URL(req.url).searchParams.get("t");
  if (!token) return page("קישור לא תקין", "חסר קוד הסרה בקישור.");

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return page("שגיאה", "השירות אינו זמין כרגע, נסו שוב מאוחר יותר.");
  const admin = createClient(url, serviceKey);

  const { data, error } = await admin
    .from("lalum_newsletter_subscribers")
    .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() })
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (error || !data) return page("קישור לא תקין", "לא נמצאה הרשמה התואמת לקישור זה — ייתכן שכבר בוטלה.");
  return page("ההרשמה בוטלה", "הוסרתם בהצלחה מרשימת התפוצה של LALUM. לא תקבלו עדכונים נוספים.");
});
