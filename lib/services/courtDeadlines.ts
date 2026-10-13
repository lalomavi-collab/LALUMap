// Israeli court deadline calculator: counts calendar days and skips court recess.
//
// Verified sources (each read against its own text, two independent copies agree):
//  * Civil Procedure Regulations 5779-2018, reg. 179(a): counting starts from the day of service;
//    reg. 179(b): "a court recess period is not counted in the days set in these regulations or set by the
//    court, unless the court ordered otherwise". Checked in the Reshumot original (Kovetz HaTakanot 8085,
//    olaw.org.il/takanot/takanot-8085.pdf) and the consolidated text (he.wikisource.org).
//  * Courts (Recesses) Regulations 5743-1983, reg. 1: Sukkot 14-22 Tishrei, Pesach 14-21 Nisan,
//    summer 21 July - 5 September; reg. 4: a Friday that is the LAST day counts as a recess day.
//    Checked in he.wikisource.org and judgments.org.il (both list amendments up to 5780 / 5781).
// Not modelled (the result says so in `notes`): court-ordered departures from reg. 179(b), emergency or
// strike orders, Yom HaZikaron and other days a court registry may close. A lawyer confirms the date.

export type Ymd = string; // 'YYYY-MM-DD'

export const RULES = ['CIVIL_PROCEDURE_REGULATIONS'] as const;
export type RuleCode = (typeof RULES)[number];

export interface Segment {
  kind: 'COUNTED' | 'RECESS';
  from: Ymd;
  to: Ymd;
  days: number;
  label?: string;
}
export interface DeadlineResult {
  rule: RuleCode;
  serviceDate: Ymd;
  periodDays: number;
  /** last day of the counted period before any rest-day roll */
  countedEnd: Ymd;
  finalDate: Ymd;
  recessDaysFrozen: number;
  segments: Segment[];
  rolled: Array<{ date: Ymd; reason: string }>;
  notes: string[];
}

const DAY = 86_400_000;
const parse = (s: Ymd) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date): Ymd => d.toISOString().slice(0, 10);
const addDays = (s: Ymd, n: number): Ymd => fmt(new Date(parse(s).getTime() + n * DAY));

const heb = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', month: 'long', day: 'numeric' });
function hebrewMonthDay(s: Ymd): { month: string; day: number } {
  const parts = heb.formatToParts(parse(s));
  return { month: parts.find((p) => p.type === 'month')!.value, day: Number(parts.find((p) => p.type === 'day')!.value) };
}

/** Name of the recess that contains the date (court recess, reg. 1), or null. */
export function recessOf(s: Ymd): string | null {
  const md = s.slice(5);
  if (md >= '07-21' && md <= '09-05') return 'פגרת הקיץ';
  const h = hebrewMonthDay(s);
  if (h.month === 'Tishri' && h.day >= 14 && h.day <= 22) return 'פגרת סוכות';
  if (h.month === 'Nisan' && h.day >= 14 && h.day <= 21) return 'פגרת הפסח';
  return null;
}

/** Why a last day cannot be the deadline (Saturday, Friday per reg. 4, or a Jewish holiday outside recess). */
function restDayReason(s: Ymd): string | null {
  const dow = parse(s).getUTCDay();
  if (dow === 6) return 'שבת';
  if (dow === 5) return 'יום שישי (תקנה 4 לתקנות הפגרות)';
  const h = hebrewMonthDay(s);
  if (h.month === 'Tishri' && (h.day === 1 || h.day === 2)) return 'ראש השנה';
  if (h.month === 'Tishri' && h.day === 10) return 'יום הכיפורים';
  if (h.month === 'Sivan' && h.day === 6) return 'שבועות';
  return null;
}

export function computeDeadline(serviceDate: Ymd, periodDays: number, rule: RuleCode = 'CIVIL_PROCEDURE_REGULATIONS'): DeadlineResult {
  if (!RULES.includes(rule)) throw new Error(`unknown rule ${rule}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) || Number.isNaN(parse(serviceDate).getTime())) throw new Error('bad service date');
  if (!Number.isInteger(periodDays) || periodDays < 1) throw new Error('period must be a positive integer');

  const segments: Segment[] = [];
  let cursor = serviceDate; // day of service is not counted; counting starts the next day
  let counted = 0;
  let frozen = 0;
  let open: Segment | null = null;
  const flush = () => { if (open) { segments.push(open); open = null; } };
  while (counted < periodDays) {
    cursor = addDays(cursor, 1);
    const rec = recessOf(cursor);
    if (rec) {
      if (open?.kind !== 'RECESS' || open.label !== rec) { flush(); open = { kind: 'RECESS', from: cursor, to: cursor, days: 0, label: rec }; }
      open.to = cursor; open.days++; frozen++;
    } else {
      if (open?.kind !== 'COUNTED') { flush(); open = { kind: 'COUNTED', from: cursor, to: cursor, days: 0 }; }
      open.to = cursor; open.days++; counted++;
    }
  }
  flush();
  const countedEnd = cursor;
  const rolled: DeadlineResult['rolled'] = [];
  let finalDate = countedEnd;
  for (;;) {
    const reason = restDayReason(finalDate) ?? (recessOf(finalDate) ? 'פגרה' : null);
    if (!reason) break;
    rolled.push({ date: finalDate, reason });
    finalDate = addDays(finalDate, 1);
  }
  return {
    rule, serviceDate, periodDays, countedEnd, finalDate, recessDaysFrozen: frozen, segments, rolled,
    notes: [
      'תקנה 179(ב) לתקנות סדר הדין האזרחי: ימי פגרה אינם באים במניין, זולת אם בית המשפט הורה אחרת.',
      'לא נבדקו: הוראת בית משפט חריגה, מצב חירום או שביתה, וימים שבהם המזכירות סגורה. יש לאשר את המועד לפני הגשה.',
    ],
  };
}

export function explain(r: DeadlineResult): string {
  const lines = [`המצאה: ${r.serviceDate}. תקופה: ${r.periodDays} ימים (יום ההמצאה אינו נמנה).`];
  for (const s of r.segments) {
    lines.push(s.kind === 'COUNTED' ? `נמנו ${s.days} ימים: ${s.from} עד ${s.to}.` : `${s.label} (מוקפא): ${s.from} עד ${s.to}, ${s.days} ימים.`);
  }
  for (const x of r.rolled) lines.push(`${x.date} אינו יום הגשה (${x.reason}); נדחה ליום הבא.`);
  lines.push(`מועד אחרון: ${r.finalDate}.`);
  return lines.join('\n');
}
