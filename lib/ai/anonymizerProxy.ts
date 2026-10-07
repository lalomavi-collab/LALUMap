// LALUM PII Shield: converts sensitive entities into semantic placeholders before anything
// can reach an external LLM. Detection is deterministic (checksums, context, dictionary,
// Hebrew title heuristics); there is no model in the loop, so it fails closed and is testable.

import { EphemeralVault } from '../crypto/ephemeralVault.ts';
import { PiiLeakError } from './types.ts';
import type { DeclaredParty, PartyRole, PiiKind, PublicEntity, SensitiveDetection } from './types.ts';

const NIQQUD = /[֑-ׇ]/g;
const HEB = '\\u05D0-\\u05EA';
const HEB_PREFIX = '(?:[והבכלמש]{1,3})?';
const COMPANY_SUFFIXES = /(?<![א-תA-Za-z])(בע"?מ|ltd\.?|limited|inc\.?|llc|gmbh)(?![א-תA-Za-z])/giu;

export function stripNiqqud(s: string): string {
  return s.replace(NIQQUD, '');
}

/** 1:1 character normalisation (offsets preserved): Hebrew punctuation and curly quotes to ASCII. */
export function normalizePunctuation(s: string): string {
  return s.replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'");
}

export function normalizeName(s: string): string {
  return stripNiqqud(normalizePunctuation(s))
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/"/g, '')
    .replace(/[־\-‐-―]/g, ' ')
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const digitsOnly = (s: string): string => s.replace(/\D/g, '');
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Israeli ID check digit (also valid for corporate numbers). */
export function isValidIsraeliId(input: string): boolean {
  const d = digitsOnly(input);
  if (d.length < 5 || d.length > 9) return false;
  const id = d.padStart(9, '0');
  if (/^0+$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

const ID_CONTEXT = /(ת[.״"']?\s?ז[.']?|תעודת\s+זהות|מס['׳]?\s*זהות|מספר\s+זהות|\bID\b|passport|דרכון)[\s:.\-מס'׳]*$/iu;
const CORP_CONTEXT = /(ח[.״"']?\s?פ[.']?|ח[.״"']?\s?צ[.']?|ע[.״"']?\s?ר[.']?|מס['׳]?\s*(חברה|תאגיד|עמותה|שותפות)|company\s+(no|number|reg))[\s:.\-מס'׳]*$/iu;

interface Raw {
  kind: PiiKind;
  start: number;
  end: number;
  value: string;
  confidence: number;
  role: PartyRole | 'UNKNOWN';
}

const lookbehind = (text: string, idx: number, n = 40): string => text.slice(Math.max(0, idx - n), idx);
const push = (out: Raw[], d: Raw): void => { if (d.end > d.start) out.push(d); };
const det = (kind: PiiKind, start: number, value: string, confidence = 1, role: Raw['role'] = 'UNKNOWN'): Raw =>
  ({ kind, start, end: start + value.length, value, confidence, role });

export function detectStructured(text: string): Raw[] {
  const out: Raw[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g)) push(out, det('EMAIL', m.index!, m[0]));
  for (const m of text.matchAll(/\bIL\d{2}(?:[\s-]?\d{4}){4}[\s-]?\d{3}\b/gi)) push(out, det('BANK_ACCOUNT', m.index!, m[0]));
  const phoneRe = /(?<![\w])(?:(?:\+|00)?972[\s-]?|0)(?:5\d|7\d|[2-489])[\s-]?\d{3}[\s-]?\d{4}(?![\w])/g;
  for (const m of text.matchAll(phoneRe)) push(out, det('PHONE', m.index!, m[0]));

  const bankRe = /(חשבון(?:\s+בנק)?(?:\s+מס['׳]?|\s+מספר)?\s*:?\s*)(\d[\d\-/]{3,14}\d)/gdu;
  for (const m of text.matchAll(bankRe)) {
    const [s, e] = m.indices![2];
    push(out, { kind: 'BANK_ACCOUNT', start: s, end: e, value: m[2], confidence: 0.95, role: 'UNKNOWN' });
  }

  const passRe = /((?:passport|דרכון)(?:\s+(?:no|number|מס['׳]?|מספר))?\s*[:.]?\s*)([A-Z]{0,2}\d{6,9})/gdiu;
  for (const m of text.matchAll(passRe)) {
    const [s, e] = m.indices![2];
    push(out, { kind: 'ID_NUMBER', start: s, end: e, value: m[2], confidence: 0.95, role: 'UNKNOWN' });
  }

  const numRe = /(?<![\w/]|\d[.,])(\d{2,8}-\d|\d{5,9})(?![\w/]|[.,]\d)/g;
  for (const m of text.matchAll(numRe)) {
    const raw = m[0];
    const digits = digitsOnly(raw);
    const before = lookbehind(text, m.index!);
    const corpCtx = CORP_CONTEXT.test(before);
    const idCtx = ID_CONTEXT.test(before);
    const valid = digits.length >= 8 && isValidIsraeliId(digits);
    let kind: PiiKind | null = null;
    let confidence = 0;
    if (corpCtx) { kind = 'COMPANY_REG'; confidence = valid ? 1 : 0.9; }
    else if (idCtx) { kind = 'ID_NUMBER'; confidence = valid ? 1 : 0.9; }
    else if (digits.length === 9 && valid) { kind = /^5[0-8]\d{7}$/.test(digits) ? 'COMPANY_REG' : 'ID_NUMBER'; confidence = 1; }
    if (kind) push(out, det(kind, m.index!, raw, confidence));
  }

  // Land registry: only the numbers become tokens; the words גוש / חלקה stay readable.
  const combined = /(?:גוש\s*\/\s*חלקה|גו"ח)\s*:?\s*(\d{1,6})\s*\/\s*(\d{1,5})/gdu;
  for (const m of text.matchAll(combined)) {
    for (const g of [1, 2]) {
      const [s, e] = m.indices![g];
      push(out, { kind: 'LAND_PARCEL', start: s, end: e, value: m[g], confidence: 1, role: 'UNKNOWN' });
    }
  }
  const landRules = [
    /(גוש(?:\s+מס['׳]?)?\s*:?\s*)(\d{3,6})/gdu,
    /((?<!תת[\s-])חלק(?:ה|ות)(?:\s+מס['׳]?)?\s*:?\s*)(\d{1,5})/gdu,
    /(תת[\s-]?חלק(?:ה|ות)(?:\s+מס['׳]?)?\s*:?\s*)(\d{1,4})/gdu,
  ];
  for (const re of landRules) {
    for (const m of text.matchAll(re)) {
      const [s, e] = m.indices![2];
      push(out, { kind: 'LAND_PARCEL', start: s, end: e, value: m[2], confidence: 1, role: 'UNKNOWN' });
    }
  }
  return out;
}

export function detectDictionary(text: string, parties: DeclaredParty[]): Raw[] {
  const out: Raw[] = [];
  for (const p of parties) {
    for (const name of [p.name, ...(p.aliases ?? [])]) {
      if (!name || name.trim().length < 2) continue;
      const body = stripNiqqud(name).trim().split(/\s+/).map((w) => escapeRegex(w).replace(/["״]/g, '["״]?').replace(/['׳]/g, "['׳]?")).join('\\s+');
      const prefix = /[א-ת]/.test(name) ? HEB_PREFIX : '';
      const re = new RegExp(`(?<![${HEB}A-Za-z0-9])${prefix}(${body})(?![${HEB}A-Za-z0-9])`, 'gdiu');
      for (const m of text.matchAll(re)) {
        const [s, e] = m.indices![1];
        push(out, { kind: 'CLIENT_NAME', start: s, end: e, value: m[1], confidence: 1, role: p.role });
      }
    }
    for (const [id, kind] of [[p.idNumber, 'ID_NUMBER'], [p.companyReg, 'COMPANY_REG']] as const) {
      if (!id) continue;
      const d = digitsOnly(id);
      if (d.length < 5) continue;
      for (const m of text.matchAll(/\d[\d-]{4,10}\d/g)) {
        if (digitsOnly(m[0]) === d) push(out, det(kind, m.index!, m[0], 1, p.role));
      }
    }
  }
  return out;
}

const TITLE_RE = new RegExp(
  String.raw`(?<![${HEB}])(?:[וש]?ה?)(?:מר|גב['׳]|גברת|עו"ד|עו״ד|ד"ר|ד״ר|פרופ['׳]|רו"ח|רו״ח|שמאי(?:ת)?|המנוח(?:ה)?|הקטינ?(?:ה)?|התובע(?:ת)?|הנתבע(?:ת)?|המבקש(?:ת)?|המשיב(?:ה)?|המערער(?:ת)?|יורש(?:ת)?)\s+` +
    String.raw`([${HEB}][${HEB}'׳"״\-]+(?:\s+[${HEB}][${HEB}'׳"״\-]+)?)`,
  'gdu',
);
const EN_TITLE_RE = /\b(?:Mr|Mrs|Ms|Dr|Adv|Prof)\.?\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/gd;
const STOP = new Set(
  `על של את כי אשר הנ"ל הנ״ל טען טענה אמר אמרה הגיש הגישה חתם חתמה ציין ציינה השיב השיבה יליד ילידת ת"ז ת״ז מס' מס׳ בע"מ בע״מ וכן או גם לא כן היה היתה הודיע הודיעה מסר מסרה לפי בגין חברה חברת עמותה שותפות בעל בעלת הוא היא הינו הינה באמצעות ב"כ ב״כ ע"י ע״י מטעם בין לבין להלן ובין וכן מאת עם אל כנגד נגד מול מר גב' גב׳ גברת עו"ד עו״ד ד"ר ד״ר פרופ' רו"ח רו״ח שמאי אני שמי`.split(' '),
);
const HW = `[${HEB}][${HEB}'׳"״\\-]+`;
const ANCHOR_ID_RE = new RegExp(String.raw`((?:${HW}\s+){0,2}${HW})\s*,?\s*(?=ת[.״"']?\s?ז)`, 'gdu');
const ORG_RE = new RegExp(String.raw`((?:${HW}\s+){0,3}${HW})\s+(בע["״]?מ|Ltd\.?|LLC)`, 'gdu');

function trimLeftToName(m: RegExpMatchArray, confidence: number, withSuffix: boolean): Raw | null {
  const [g1s, g1e] = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[1];
  const words = [...m[1].matchAll(/\S+/gu)].map((w) => ({ w: w[0], at: g1s + w.index! }));
  let cut = 0;
  words.forEach((x, i) => {
    if (STOP.has(x.w) || /^[ולבמש]?(?:בין|לבין|חברת|להלן|הנתבעת|התובעת|הנתבע|התובע)$/u.test(x.w)) cut = i + 1;
  });
  const kept = words.slice(cut);
  if (!kept.length) return null;
  const start = kept[0].at;
  const end = withSuffix ? m.index! + m[0].length : g1e;
  return { kind: 'CLIENT_NAME', start, end, value: (m.input ?? '').slice(start, end), confidence, role: 'UNKNOWN' };
}

export function detectHeuristicNames(text: string): Raw[] {
  const out: Raw[] = [];
  for (const m of text.matchAll(TITLE_RE)) {
    const [s] = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[1];
    const kept: string[] = [];
    for (const w of m[1].split(/\s+/)) { if (STOP.has(w)) break; kept.push(w); }
    if (!kept.length) continue;
    const value = kept.join(' ');
    out.push({ kind: 'CLIENT_NAME', start: s, end: s + value.length, value, confidence: 0.75, role: 'UNKNOWN' });
  }
  for (const m of text.matchAll(ANCHOR_ID_RE)) { const d = trimLeftToName(m, 0.8, false); if (d) out.push(d); }
  for (const m of text.matchAll(ORG_RE)) { const d = trimLeftToName(m, 0.8, true); if (d) out.push(d); }
  for (const m of text.matchAll(EN_TITLE_RE)) {
    const [s, e] = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[1];
    out.push({ kind: 'CLIENT_NAME', start: s, end: e, value: m[1], confidence: 0.75, role: 'UNKNOWN' });
  }
  return out;
}

function resolveOverlaps(all: Raw[]): Raw[] {
  const ranked = [...all].sort((a, b) => b.confidence - a.confidence || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken: Raw[] = [];
  for (const d of ranked) if (!taken.some((t) => d.start < t.end && t.start < d.end)) taken.push(d);
  return taken.sort((a, b) => a.start - b.start);
}

export function canonicalValue(kind: PiiKind, value: string): string {
  switch (kind) {
    case 'EMAIL': return value.trim().toLowerCase();
    case 'PHONE': { const d = digitsOnly(value); return d.startsWith('972') ? `0${d.slice(3)}` : d; }
    case 'ID_NUMBER': case 'COMPANY_REG': return /^\d[\d-]*$/.test(value) ? digitsOnly(value).padStart(9, '0') : value.toUpperCase();
    case 'BANK_ACCOUNT': return value.replace(/[\s-]/g, '').toUpperCase();
    case 'LAND_PARCEL': return digitsOnly(value);
    default: return `name:${normalizeName(value)}`;
  }
}

const TOKEN_RE = /\[([A-Z][A-Z_]*)_(\d+)\]/g;

export interface AnonymizeResult {
  masked: string;
  entities: PublicEntity[];
  counts: Partial<Record<PiiKind, number>>;
  needsReview: number;
  /** Plaintext values. In-memory only: for the conflict engine, then dropped. */
  detections: SensitiveDetection[];
}

export class LalumAnonymizerProxy {
  private vault: EphemeralVault;
  private parties: DeclaredParty[];
  private allow: Set<string>;
  private reviewThreshold: number;

  constructor(opts: { vault: EphemeralVault; parties?: DeclaredParty[]; allowlist?: string[]; reviewThreshold?: number }) {
    this.vault = opts.vault;
    this.parties = opts.parties ?? [];
    this.allow = new Set((opts.allowlist ?? []).map(normalizeName));
    this.reviewThreshold = opts.reviewThreshold ?? 0.85;
  }

  /** Continue numbering above tokens already present in previously masked text (e.g. editor drafts). */
  reserveFrom(maskedText: string): void {
    for (const m of maskedText.matchAll(TOKEN_RE)) this.vault.reserve(m[1], Number(m[2]));
  }

  detect(text: string): Raw[] {
    const norm = normalizePunctuation(text); // 1:1, offsets preserved
    const all = [...detectStructured(norm), ...detectDictionary(norm, this.parties), ...detectHeuristicNames(norm)];
    return resolveOverlaps(all.filter((d) => !(d.kind === 'CLIENT_NAME' && this.allow.has(normalizeName(d.value)))));
  }

  async anonymize(text: string): Promise<AnonymizeResult> {
    const found = this.detect(text);
    const counts: AnonymizeResult['counts'] = {};
    const detections: SensitiveDetection[] = [];
    const tokens: string[] = [];
    let needsReview = 0;
    for (const d of found) {
      const value = text.slice(d.start, d.end);
      const token = await this.vault.tokenize(d.kind, value, canonicalValue(d.kind, value));
      tokens.push(token);
      counts[d.kind] = (counts[d.kind] ?? 0) + 1;
      if (d.confidence < this.reviewThreshold) needsReview++;
      detections.push({ token, kind: d.kind, start: d.start, end: d.end, value, confidence: d.confidence, role: d.role });
    }
    let masked = text;
    for (let i = found.length - 1; i >= 0; i--) masked = masked.slice(0, found[i].start) + tokens[i] + masked.slice(found[i].end);
    this.assertClean(masked);
    return { masked, entities: detections.map(({ token, kind, start, end }) => ({ token, kind, start, end })), counts, needsReview, detections };
  }

  /** Fail-closed egress guard: re-scan text about to leave the trusted zone. */
  assertClean(text: string): void {
    const norm = normalizePunctuation(text);
    const residual = resolveOverlaps([...detectStructured(norm), ...detectDictionary(norm, this.parties)]);
    if (residual.length) throw new PiiLeakError([...new Set(residual.map((d) => d.kind))]);
  }
}
