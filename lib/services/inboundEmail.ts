// Pure helpers for the inbound e-mail channel (no I/O): routing alias, sender, automated-mail filter, text extraction.

const ALIAS_RE = /^inq-([0-9a-f]{10})@lalumapp\.com$/i;

/** The firm alias from the first recipient address that has the inquiry form, else null. */
export function aliasFrom(recipients: unknown[]): string | null {
  for (const r of recipients) {
    const a = addressOf(String(r ?? ''));
    const m = a ? ALIAS_RE.exec(a) : null;
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** "Name <a@b.co>" or "a@b.co" -> "a@b.co" lowercased, or null. */
export function addressOf(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(from);
  return m ? m[1].toLowerCase() : null;
}

const ROBOT = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce|bounces|notifications?)@/i;

/** Bounces, auto-replies and bulk mail: never become an inquiry (and never trigger an answer loop). */
export function isAutomated(sender: string, headers: unknown): boolean {
  if (ROBOT.test(sender)) return true;
  const get = (name: string): string => {
    if (Array.isArray(headers)) {
      const h = (headers as Array<{ name?: string; value?: string }>).find((x) => String(x?.name ?? '').toLowerCase() === name);
      return String(h?.value ?? '').toLowerCase();
    }
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === name) return String(v ?? '').toLowerCase();
    }
    return '';
  };
  const auto = get('auto-submitted');
  if (auto && auto !== 'no') return true;
  if (/(bulk|junk|list)/.test(get('precedence'))) return true;
  return get('x-auto-response-suppress') !== '' && /oof|autoreply/.test(get('x-auto-response-suppress'));
}

/** Plain text of a message; HTML is reduced to text when no text part exists. Capped. */
export function bodyText(text: unknown, html: unknown, max = 20000): string {
  let t = typeof text === 'string' && text.trim() ? text : '';
  if (!t && typeof html === 'string') {
    t = html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
