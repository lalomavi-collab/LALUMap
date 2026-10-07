// Conflict check engine with a no-leak policy.
//  * Tenant isolation: every lookup is scoped to ONE firm (enforced again inside the SQL function).
//  * No plaintext party names are stored: names, IDs and company numbers are kept as
//    HMAC-SHA256 blind indexes under a per-firm key.
//  * On RED the caller gets one fixed neutral sentence. Reason codes and match counts go only
//    to the firm's own compliance audit log, never to the submitter.

import { digitsOnly, normalizeName } from './anonymizerProxy.ts';
import type { ConflictStatus, DeclaredParty, PartyRole, SensitiveDetection, TrafficLight } from './types.ts';

export const NEUTRAL_REJECTION_MESSAGE = 'בשל כללי האתיקה ומניעת ניגוד עניינים, נמנע מאיתנו לקבל את הטיפול בפנייה.';

export type IndexKind = 'NAME' | 'NAME_TOKEN' | 'ID' | 'COMPANY';
export interface BlindIndex { kind: IndexKind; blind_index: string }
export interface StoredRow { party_id: string; role: PartyRole; kind: IndexKind; blind_index: string; matter_active: boolean }

export interface ConflictStore {
  /** Rows for these indexes inside one firm. Must never return another firm's rows. */
  find(firmId: string, indexes: string[], excludeMatterId?: string): Promise<StoredRow[]>;
}

export interface ConflictParty {
  partyId: string;
  role: PartyRole;
  indexes: BlindIndex[];
}

export interface ConflictResult {
  light: TrafficLight;
  status: ConflictStatus;
  reasonCodes: string[];
  matchCount: number;
  entityCount: number;
  halted: boolean;
  /** Present only when halted. */
  neutralMessage?: string;
  /** Blind-indexed parties to register once the matter is provisioned (never when halted). */
  parties: ConflictParty[];
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

export async function blindIndex(keyHex: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromHex(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)));
}

const LIGHT_TO_STATUS: Record<TrafficLight, ConflictStatus> = { GREEN: 'CLEAN', YELLOW: 'POTENTIAL', RED: 'DIRECT_CONFLICT' };
const RANK: Record<TrafficLight, number> = { GREEN: 0, YELLOW: 1, RED: 2 };
const worst = (a: TrafficLight, b: TrafficLight): TrafficLight => (RANK[a] >= RANK[b] ? a : b);
const isOpposing = (a: PartyRole, b: PartyRole): boolean => (a === 'ADVERSE' && b === 'CLIENT') || (a === 'CLIENT' && b === 'ADVERSE');

interface RawParty {
  role: PartyRole;
  names: string[];
  ids: string[];
  companies: string[];
}

/** Build the set of parties to check: declared ones first, then anything the shield detected that they do not cover. */
export function collectParties(declared: DeclaredParty[], detections: SensitiveDetection[]): RawParty[] {
  const parties: RawParty[] = declared.map((p) => ({
    role: p.role,
    names: [p.name, ...(p.aliases ?? [])].filter((x): x is string => !!x && normalizeName(x).length >= 2),
    ids: p.idNumber ? [digitsOnly(p.idNumber).padStart(9, '0')] : [],
    companies: p.companyReg ? [digitsOnly(p.companyReg).padStart(9, '0')] : [],
  }));
  const covered = (kind: IndexKind, v: string): boolean =>
    parties.some((p) => (kind === 'NAME' ? p.names.some((n) => normalizeName(n) === v) : kind === 'ID' ? p.ids.includes(v) : p.companies.includes(v)));
  for (const d of detections) {
    if (d.kind === 'CLIENT_NAME') {
      const v = normalizeName(d.value);
      if (v.length < 2 || covered('NAME', v)) continue;
      parties.push({ role: 'OTHER', names: [d.value], ids: [], companies: [] });
    } else if (d.kind === 'ID_NUMBER' || d.kind === 'COMPANY_REG') {
      const v = digitsOnly(d.value).padStart(9, '0');
      const kind: IndexKind = d.kind === 'ID_NUMBER' ? 'ID' : 'COMPANY';
      if (digitsOnly(d.value).length < 5 || covered(kind, v)) continue;
      parties.push({ role: 'OTHER', names: [], ids: kind === 'ID' ? [v] : [], companies: kind === 'COMPANY' ? [v] : [] });
    }
  }
  // one party entry per distinct role+identity
  const seen = new Set<string>();
  return parties.filter((p) => {
    const k = `${p.role}|${p.names.map(normalizeName).join(',')}|${p.ids.join(',')}|${p.companies.join(',')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class ConflictEngine {
  private store: ConflictStore;
  private keyHex: string;

  constructor(store: ConflictStore, firmKeyHex: string) {
    this.store = store;
    this.keyHex = firmKeyHex;
  }

  private async indexParty(p: RawParty): Promise<{ strong: BlindIndex[]; weak: BlindIndex[] }> {
    const strong: BlindIndex[] = [];
    const weak: BlindIndex[] = [];
    for (const n of p.names) {
      const norm = normalizeName(n);
      strong.push({ kind: 'NAME', blind_index: await blindIndex(this.keyHex, `name:${norm}`) });
      const tokens = [...new Set(norm.split(' ').filter((t) => t.length >= 2))];
      if (tokens.length >= 2) for (const t of tokens) weak.push({ kind: 'NAME_TOKEN', blind_index: await blindIndex(this.keyHex, `tok:${t}`) });
    }
    for (const id of p.ids) strong.push({ kind: 'ID', blind_index: await blindIndex(this.keyHex, `id:${id}`) });
    for (const c of p.companies) strong.push({ kind: 'COMPANY', blind_index: await blindIndex(this.keyHex, `co:${c}`) });
    return { strong, weak };
  }

  async check(firmId: string, declared: DeclaredParty[], detections: SensitiveDetection[], opts: { excludeMatterId?: string } = {}): Promise<ConflictResult> {
    const raw = collectParties(declared, detections);
    const indexed = await Promise.all(raw.map((p) => this.indexParty(p)));
    const all = [...new Set(indexed.flatMap((x) => [...x.strong, ...x.weak].map((i) => i.blind_index)))];
    const rows = all.length ? await this.store.find(firmId, all, opts.excludeMatterId) : [];

    // group stored rows by stored party
    const byParty = new Map<string, { role: PartyRole; active: boolean; idx: Map<string, IndexKind> }>();
    for (const r of rows) {
      const g = byParty.get(r.party_id) ?? { role: r.role, active: false, idx: new Map<string, IndexKind>() };
      g.active = g.active || r.matter_active;
      g.idx.set(r.blind_index, r.kind);
      byParty.set(r.party_id, g);
    }

    let light = 'GREEN' as TrafficLight;
    const reasons = new Set<string>();
    let matchCount = 0;
    raw.forEach((p, i) => {
      const strongSet = new Set(indexed[i].strong.map((x) => x.blind_index));
      const weakSet = new Set(indexed[i].weak.map((x) => x.blind_index));
      for (const g of byParty.values()) {
        const strongHit = [...g.idx.keys()].some((k) => strongSet.has(k) && g.idx.get(k) !== 'NAME_TOKEN');
        const weakHits = [...g.idx.keys()].filter((k) => weakSet.has(k) && g.idx.get(k) === 'NAME_TOKEN').length;
        if (!strongHit && weakHits < 2) continue;
        matchCount++;
        const opposing = isOpposing(p.role, g.role);
        let l: TrafficLight = 'GREEN';
        if (strongHit && opposing) {
          l = g.active ? 'RED' : 'YELLOW';
          reasons.add(g.active ? (p.role === 'ADVERSE' ? 'ADVERSE_IS_ACTIVE_CLIENT' : 'CLIENT_IS_ACTIVE_ADVERSE') : 'OPPOSING_HISTORICAL_MATTER');
        } else if (strongHit && (p.role === 'OTHER' || g.role === 'OTHER')) {
          l = 'YELLOW';
          reasons.add('ROLE_UNKNOWN_MATCH');
        } else if (!strongHit && opposing) {
          l = 'YELLOW';
          reasons.add('PARTIAL_NAME_MATCH_OPPOSING');
        }
        light = worst(light, l);
      }
    });

    const halted = light === 'RED';
    const parties: ConflictParty[] = halted
      ? []
      : raw.map((p, i) => ({ partyId: crypto.randomUUID(), role: p.role, indexes: [...indexed[i].strong, ...indexed[i].weak] }));
    return {
      light,
      status: LIGHT_TO_STATUS[light],
      reasonCodes: [...reasons].sort(),
      matchCount,
      entityCount: raw.length,
      halted,
      neutralMessage: halted ? NEUTRAL_REJECTION_MESSAGE : undefined,
      parties,
    };
  }
}
