// Pure HTML templates for the two billing documents. HTML is the source; render.ts turns it into PDF.
//  * Pre-bill ("heshbon isqa"): NOT a tax document. The legal tax invoice (with the Tax Authority allocation
//    number) is issued by Invoice4U; its reference is printed here only when it exists.
//  * Trust deposit receipt: NOT a tax document, own TR- series, 0% VAT, client money held in trust.
import { LALUM_LOGO_SVG } from './logo.ts';

export interface FirmInfo { name: string; registrationNo: string; email: string; phone: string }
/** One line of lalum_fin_documents.lines (services and expenses are mixed in one array by the finance engine). */
export interface Line { name: string; qty: number; price: number }
export interface PreBillData {
  firm: FirmInfo; docRef: string; issuedOn: string; dueOn?: string; subject?: string;
  customer: { name: string; taxId?: string; address?: string };
  matterTitle?: string; courtCaseNo?: string; handlingAttorney?: string;
  lines: Line[]; taxIncluded: boolean; vatRatePct: number;   // vat_rate is stored as a percent (18), not a fraction
  trustApplied: number;                                       // sum of EARNED_FEE_TRANSFER for this document
  taxDocRef?: string; allocationNumber?: string;              // only when Invoice4U issued the legal tax invoice
  bankInstructions?: string;
}
export interface TrustReceiptData {
  firm: FirmInfo; receiptNo: string; receivedOn: string; depositedBy: string;
  trustAccount: string; matterTitle: string; amount: number; balanceAfter: number;
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Deterministic, bidi-safe amount: sign and shekel sign stay on the left of the digits in an LTR cell. */
export const money = (n: number): string => `₪${num.format(n)}`;
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Same arithmetic as lalum_fin_totals / computeTotals in lalum-app: sum the lines first, round once. */
export function preBillTotals(d: Pick<PreBillData, 'lines' | 'taxIncluded' | 'vatRatePct' | 'trustApplied'>) {
  const sum = d.lines.reduce((a, l) => a + l.qty * l.price, 0);
  let subtotal: number, vat: number, total: number;
  if (d.taxIncluded) { total = r2(sum); subtotal = r2(sum / (1 + d.vatRatePct / 100)); vat = r2(total - subtotal); }
  else { subtotal = r2(sum); vat = r2((subtotal * d.vatRatePct) / 100); total = r2(subtotal + vat); }
  if (d.trustApplied < 0 || d.trustApplied > total) throw new Error('trust offset exceeds document total');
  return { subtotal, vat, total, balanceDue: r2(total - d.trustApplied) };
}

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
:root { --obsidian:#1B1B1B; --gold:#D4AF37; --cream:#FFFDD0; --burgundy:#800020; }
* { box-sizing: border-box; }
body { font-family: "Heebo","Arial",sans-serif; color: var(--obsidian); font-size: 11pt; line-height: 1.5; margin: 0; }
header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid var(--gold); padding-bottom:10px; margin-bottom:14px; }
.logo { width: 150px; direction: ltr; } .logo svg { width:100%; height:auto; }
.firm { font-size:10pt; } .firm b { font-size:12pt; }
h1 { font-size:18pt; margin:6px 0 2px; } h2 { font-size:12pt; margin:16px 0 6px; border-right:4px solid var(--gold); padding-right:8px; }
.banner { background:var(--burgundy); color:#fff; padding:8px 12px; font-weight:700; margin:8px 0; }
.box { background:var(--cream); border:1px solid var(--gold); padding:8px 12px; }
table { width:100%; border-collapse:collapse; font-size:10pt; } th { background:var(--obsidian); color:#fff; text-align:right; padding:5px 6px; }
td { padding:5px 6px; border-bottom:1px solid #ddd; } td.n, th.n { text-align:left; direction:ltr; white-space:nowrap; }
.sum td { border:none; } .sum tr.total td { font-weight:700; border-top:2px solid var(--obsidian); }
.sum tr.trust td { font-weight:700; color:var(--burgundy); background:var(--cream); }
.ltr { direction:ltr; unicode-bidi:isolate; display:inline-block; }
.sign { margin-top:28px; display:flex; gap:30px; } .sign div { flex:1; border-top:1px solid var(--obsidian); padding-top:4px; font-size:9pt; }
.disc { margin-top:18px; font-size:8.5pt; color:#555; text-align:justify; }
.big { font-size:20pt; font-weight:700; }
`;

function shell(title: string, firm: FirmInfo, body: string): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><div class="firm"><b>${esc(firm.name)}</b><br>עוסק מורשה / ח״פ: <span class="ltr">${esc(firm.registrationNo)}</span><br><span class="ltr">${esc(firm.email)}</span> · <span class="ltr">${esc(firm.phone)}</span></div>
<div class="logo">${LALUM_LOGO_SVG}</div></header>${body}</body></html>`;
}

export function preBillHtml(d: PreBillData): string {
  const t = preBillTotals(d);
  const rows = d.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${money(l.price)}</td><td class="n">${money(r2(l.qty * l.price))}</td></tr>`).join('');
  const taxLine = d.taxDocRef
    ? `חשבונית מס מספר <span class="ltr">${esc(d.taxDocRef)}</span>${d.allocationNumber ? ` · מספר הקצאה: <span class="ltr">${esc(d.allocationNumber)}</span>` : ''}`
    : 'חשבונית המס תונפק בנפרד ותישא מספר הקצאה מרשות המסים (חשבוניות ישראל).';
  const body = `
<h1>חשבון עסקה</h1><div class="banner">מסמך זה אינו חשבונית מס</div>
<div class="box">מספר: <b class="ltr">${esc(d.docRef)}</b> · תאריך: ${esc(d.issuedOn)}${d.dueOn ? ` · לתשלום עד: ${esc(d.dueOn)}` : ''}<br>${taxLine}</div>
<h2>פרטי הלקוח והתיק</h2>
<div class="box">לקוח: <b>${esc(d.customer.name)}</b>${d.customer.taxId ? ` · ת״ז / ח״פ: <span class="ltr">${esc(d.customer.taxId)}</span>` : ''}${d.customer.address ? `<br>${esc(d.customer.address)}` : ''}
${d.matterTitle ? `<br>תיק: <b>${esc(d.matterTitle)}</b>` : ''}${d.subject ? `<br>נושא: ${esc(d.subject)}` : ''}
${d.courtCaseNo ? `<br>מספר תיק בית משפט: <span class="ltr">${esc(d.courtCaseNo)}</span>` : ''}${d.handlingAttorney ? `<br>עורך דין מטפל: ${esc(d.handlingAttorney)}` : ''}</div>
<h2>פירוט שירותים והוצאות</h2>
<table><tr><th>תיאור</th><th class="n">כמות</th><th class="n">מחיר ליחידה</th><th class="n">סכום</th></tr>${rows || '<tr><td colspan="4">אין</td></tr>'}</table>
<h2>סיכום כספי</h2>
<table class="sum">
<tr><td>סכום לפני מע״מ</td><td class="n">${money(t.subtotal)}</td></tr>
<tr><td>מע״מ (${d.vatRatePct}%)</td><td class="n">${money(t.vat)}</td></tr>
<tr class="total"><td>סה״כ כולל מע״מ</td><td class="n">${money(t.total)}</td></tr>
<tr class="trust"><td>קוזז מפיקדון בנאמנות</td><td class="n">-${money(d.trustApplied)}</td></tr>
<tr class="total"><td>יתרה לתשלום (Balance Due)</td><td class="n big">${money(t.balanceDue)}</td></tr></table>
<div class="sign"><div>חתימה אלקטרונית מאושרת: מקום לחותמת דיגיטלית</div><div>${d.bankInstructions ? esc(d.bankInstructions) : 'פרטי העברה בנקאית יימסרו על ידי המשרד'}</div></div>
<p class="disc">חשבון עסקה זה מהווה דרישת תשלום בלבד ואינו מסמך מס. הוא אינו ייעוץ משפטי ואינו מחייב כחשבונית. קיזוז מפיקדון נאמנות מבוצע מכספי הלקוח המוחזקים בנאמנות.</p>`;
  return shell(`חשבון עסקה ${d.docRef}`, d.firm, body);
}

export function trustReceiptHtml(d: TrustReceiptData): string {
  const body = `
<h1>אישור קבלת כספי פיקדון / נאמנות</h1><div class="banner">מסמך שאינו מסמך מס</div>
<div class="box">מספר אישור (סדרת נאמנות): <b class="ltr">${esc(d.receiptNo)}</b> · תאריך: ${esc(d.receivedOn)}</div>
<h2>פרטי ההפקדה</h2>
<div class="box">הופקד על ידי: ${esc(d.depositedBy)}<br>חשבון נאמנות ייעודי: <span class="ltr">${esc(d.trustAccount)}</span><br>תיק: <b>${esc(d.matterTitle)}</b></div>
<h2>סכום</h2>
<table class="sum"><tr><td>סכום שהופקד</td><td class="n big">${money(d.amount)}</td></tr>
<tr><td>מע״מ</td><td>0.00 מע״מ, כספי לקוח בנאמנות</td></tr>
<tr class="total"><td>יתרה צבורה בנאמנות בתיק זה לאחר ההפקדה</td><td class="n">${money(d.balanceAfter)}</td></tr></table>
<div class="sign"><div>חתימת שותף מנהל</div><div>חותמת המשרד</div></div>
<p class="disc">הכספים הנזכרים באישור זה מוחזקים בנאמנות עבור הלקוח ואינם הכנסה של המשרד עד למתן חשבונית מס כדין. אישור זה אינו חשבונית, אינו קבלה לצורכי מס ואינו ייעוץ משפטי.</p>`;
  return shell(`אישור נאמנות ${d.receiptNo}`, d.firm, body);
}
