// Practice-area detection and playbook risk scoring. Deterministic: keyword scoring plus
// regex rules loaded from lalum_practice_playbooks. Runs on MASKED text only.

import { normalizePunctuation } from './anonymizerProxy.ts';
import { PRACTICE_AREAS } from './types.ts';
import type { PracticeArea, TrafficLight } from './types.ts';

export interface PlaybookRule {
  id: string;
  practice_area: PracticeArea;
  rule_name: string;
  severity: TrafficLight;
  mode: 'PRESENT' | 'ABSENT';
  pattern: string;
  unless_pattern: string | null;
  description: string;
  fallback_clause: string;
  source_citation: string | null;
  source_url: string | null;
}

export interface Finding {
  ruleId: string;
  ruleName: string;
  practiceArea: PracticeArea;
  severity: TrafficLight; // GREEN when the rule is satisfied
  badge: '🔴' | '🟡' | '🟢';
  label: 'High Risk' | 'Caution' | 'Compliant';
  description: string;
  /** One-click fallback redline. Present for RED/YELLOW. */
  fallbackClause: string | null;
  citation: string | null;
  citationUrl: string | null;
  /** Offsets into the analysed (masked) text, only for PRESENT rules that fired. */
  span: { start: number; end: number } | null;
  excerpt: string | null;
}

export interface RiskSummary {
  level: 'HIGH_RISK' | 'CAUTION' | 'COMPLIANT';
  score: number; // 0..100, higher is safer
  red: number;
  yellow: number;
  green: number;
}

const BADGE = { RED: ['🔴', 'High Risk'], YELLOW: ['🟡', 'Caution'], GREEN: ['🟢', 'Compliant'] } as const;
const MAX_TEXT = 400_000;

const AREA_SIGNALS: Record<PracticeArea, Array<[RegExp, number]>> = {
  REAL_ESTATE: [
    [/תמ"?א\s*38|פינוי\s*בינוי|התחדשות\s+עירונית/giu, 4], [/\[LAND_PARCEL_\d+\]|גוש|חלקה|טאבו|נסח/giu, 2],
    [/דיירים|יזם|דירה|דירות|מקרקעין|נדל"?ן|קבלן|היתר\s+בנייה|רוכש/giu, 1.5],
  ],
  COMMERCIAL_MA: [
    [/מניות|רכישת\s+חברה|מיזוג|נאותות|due\s+diligence|share\s+purchase/giu, 3], [/מצגים|שיפוי|השלמה|תנאים\s+מתלים|תמורה|מוכר|קונה/giu, 1.5],
  ],
  LABOR_LAW: [
    [/עובד|מעביד|העסקה|שכר|פיצויי\s+פיטורים|שימוע|שעות\s+נוספות|הסכם\s+עבודה/giu, 2], [/אי\s+תחרות|הודעה\s+מוקדמת|פנסיה|הבראה|חופשה/giu, 1.5],
  ],
  AI_GOVERNANCE: [
    [/בינה\s+מלאכותית|AI\s+Act|מודל|אימון\s+המודל|אלגוריתם|machine\s+learning|LLM/giu, 3], [/הטיה|פיקוח\s+אנושי|סיכון\s+גבוה|DPIA|שקיפות/giu, 1.5],
  ],
  LITIGATION: [
    [/כתב\s+תביעה|כתב\s+הגנה|בית\s+(ה)?משפט|תובע|נתבע|צו\s+מניעה|תצהיר|הסעד|התיישנות|ערעור/giu, 2.5], [/דיון|פסק\s+דין|ערר|בקשה\s+לסעד/giu, 1],
  ],
};

export function detectPracticeArea(text: string, declared?: PracticeArea): { area: PracticeArea; confidence: number; scores: Record<PracticeArea, number> } {
  const scores = Object.fromEntries(PRACTICE_AREAS.map((a) => [a, 0])) as Record<PracticeArea, number>;
  const t = normalizePunctuation(text.slice(0, MAX_TEXT));
  for (const area of PRACTICE_AREAS) {
    for (const [re, w] of AREA_SIGNALS[area]) {
      const n = [...t.matchAll(new RegExp(re.source, re.flags))].length;
      scores[area] += Math.min(n, 8) * w;
    }
  }
  const ranked = PRACTICE_AREAS.slice().sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0];
  const total = PRACTICE_AREAS.reduce((s, a) => s + scores[a], 0);
  if (declared) return { area: declared, confidence: 1, scores };
  if (scores[top] < 3) return { area: 'COMMERCIAL_MA', confidence: 0, scores }; // no signal: schema default
  return { area: top, confidence: total ? scores[top] / total : 0, scores };
}

function compile(src: string): RegExp | null {
  try { return new RegExp(src, 'iu'); } catch { return null; }
}

function excerptAround(text: string, start: number, end: number): string {
  const s = Math.max(0, start - 60);
  const e = Math.min(text.length, end + 60);
  return `${s > 0 ? '…' : ''}${text.slice(s, e).replace(/\s+/g, ' ').trim()}${e < text.length ? '…' : ''}`;
}

export function analyze(text: string, rules: PlaybookRule[], area: PracticeArea): { findings: Finding[]; risk: RiskSummary; rulesSkipped: number } {
  const t = normalizePunctuation(text.slice(0, MAX_TEXT)); // 1:1: offsets valid for the original
  const findings: Finding[] = [];
  let skipped = 0;
  for (const r of rules.filter((x) => x.practice_area === area)) {
    const main = compile(r.pattern);
    const unless = r.unless_pattern ? compile(r.unless_pattern) : null;
    if (!main || (r.unless_pattern && !unless)) { skipped++; continue; }
    const m = main.exec(t);
    const suppressed = unless ? unless.test(t) : false;
    const fires = !suppressed && (r.mode === 'PRESENT' ? !!m : !m);
    const severity: TrafficLight = fires ? r.severity : 'GREEN';
    const span = fires && r.mode === 'PRESENT' && m ? { start: m.index, end: m.index + m[0].length } : null;
    findings.push({
      ruleId: r.id,
      ruleName: r.rule_name,
      practiceArea: r.practice_area,
      severity,
      badge: BADGE[severity][0],
      label: BADGE[severity][1],
      description: fires ? r.description : `${r.rule_name}: לא נמצאה בעיה.`,
      fallbackClause: fires ? r.fallback_clause : null,
      citation: r.source_citation,
      citationUrl: r.source_url,
      span,
      excerpt: span ? excerptAround(t, span.start, span.end) : null,
    });
  }
  const order: Record<TrafficLight, number> = { RED: 0, YELLOW: 1, GREEN: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const red = findings.filter((f) => f.severity === 'RED').length;
  const yellow = findings.filter((f) => f.severity === 'YELLOW').length;
  const green = findings.length - red - yellow;
  const score = Math.max(0, 100 - red * 25 - yellow * 10);
  const level = red ? 'HIGH_RISK' : yellow ? 'CAUTION' : 'COMPLIANT';
  return { findings, risk: { level, score, red, yellow, green }, rulesSkipped: skipped };
}
