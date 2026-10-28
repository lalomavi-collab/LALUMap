// Declaring the parties of an existing matter (4.3, T50). Until now a matter got its declared parties only when it
// was opened, and the intake form left the adverse party optional, so the RED rule (an adverse party who is an
// active client elsewhere) never received input. This lets a partner, an admin or an attorney on the matter's team
// declare the client and the adverse party of a matter that already exists.
//  * Every party is checked against the firm's conflict index before anything is stored, with the matter itself
//    excluded, exactly like a new document.
//  * RED stores nothing. The caller gets the fixed neutral sentence; the firm's own log gets a check row on the
//    matter and a CONFLICT_HALT audit line, so the partner sees it in the conflict review.
//  * YELLOW and GREEN store the blind indexes, add a check row, and raise the matter to POTENTIAL on YELLOW
//    (never lower it, never touch DIRECT_CONFLICT).
//  * Names, ID numbers and company numbers never leave this function in clear: only HMAC blind indexes are stored,
//    and the audit line carries counts only.

import { ConflictEngine } from '../ai/conflictEngine.ts';
import type { ConflictParty, ConflictStore } from '../ai/conflictEngine.ts';
import { digitsOnly, normalizeName } from '../ai/anonymizerProxy.ts';
import type { ConflictStatus, DeclaredParty, TrafficLight } from '../ai/types.ts';

export const MAX_PARTIES = 10;

export interface PartyCounts { CLIENT: number; ADVERSE: number }

export interface CheckRow {
  firm_id: string;
  matter_id: string;
  status: ConflictStatus;
  reason_codes: string[];
  match_count: number;
  entity_count: number;
  source: 'PARTIES';
  checked_by: string;
}

export interface PartiesStore extends ConflictStore {
  addParties(firmId: string, matterId: string, parties: ConflictParty[]): Promise<void>;
  removeParties(matterId: string, partyIds: string[]): Promise<void>;
  logCheck(row: CheckRow): Promise<void>;
  /** CLEAN to POTENTIAL only. */
  raiseToPotential(matterId: string): Promise<void>;
  appendAudit(firmId: string, matterId: string | null, userId: string | null, action: string, aiHash: string, meta: Record<string, unknown>): Promise<void>;
  counts(matterId: string): Promise<PartyCounts>;
  /** `${role}|${blind_index}` of the strong indexes (NAME, ID, COMPANY) already declared on the matter. */
  declaredOn(matterId: string): Promise<Set<string>>;
}

const idField = (v: unknown): string | undefined | null => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return null;
  const d = digitsOnly(v);
  return d.length >= 5 && d.length <= 9 ? d : null;
};

/** The request body's parties, or null when anything in it is malformed. Only CLIENT and ADVERSE may be declared. */
export function parseParties(raw: unknown): DeclaredParty[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_PARTIES) return null;
  const out: DeclaredParty[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    if (o.role !== 'CLIENT' && o.role !== 'ADVERSE') return null;
    const name = typeof o.name === 'string' ? o.name.trim() : o.name === undefined || o.name === null ? '' : null;
    if (name === null || name.length > 200) return null;
    const idNumber = idField(o.idNumber);
    const companyReg = idField(o.companyReg);
    if (idNumber === null || companyReg === null) return null;
    const hasName = normalizeName(name).length >= 2;
    if (!hasName && !idNumber && !companyReg) return null;
    out.push({ role: o.role, ...(hasName ? { name } : {}), ...(idNumber ? { idNumber } : {}), ...(companyReg ? { companyReg } : {}) });
  }
  return out;
}

export type DeclareResult =
  | { halted: true; light: 'RED'; neutralMessage: string }
  | { halted: false; light: Exclude<TrafficLight, 'RED'>; status: ConflictStatus; added: number; counts: PartyCounts };

export async function declareParties(
  store: PartiesStore,
  firmKeyHex: string,
  ctx: { firmId: string; userId: string; matterId: string },
  declared: DeclaredParty[],
): Promise<DeclareResult> {
  const r = await new ConflictEngine(store, firmKeyHex).check(ctx.firmId, declared, [], { excludeMatterId: ctx.matterId });
  const row = (status: ConflictStatus): CheckRow => ({
    firm_id: ctx.firmId, matter_id: ctx.matterId, status, reason_codes: r.reasonCodes,
    match_count: r.matchCount, entity_count: r.entityCount, source: 'PARTIES', checked_by: ctx.userId,
  });
  if (r.halted) {
    await store.logCheck(row('DIRECT_CONFLICT'));
    await store.appendAudit(ctx.firmId, ctx.matterId, ctx.userId, 'CONFLICT_HALT', '', { match_count: r.matchCount, source: 'PARTIES' });
    return { halted: true, light: 'RED', neutralMessage: r.neutralMessage! };
  }
  // a party already declared on this matter with the same role is not stored twice
  const have = await store.declaredOn(ctx.matterId);
  const fresh = r.parties.filter((p) => !p.indexes.some((i) => i.kind !== 'NAME_TOKEN' && have.has(`${p.role}|${i.blind_index}`)));
  if (fresh.length) await store.addParties(ctx.firmId, ctx.matterId, fresh);
  try {
    await store.logCheck(row(r.status));
    if (r.status === 'POTENTIAL') await store.raiseToPotential(ctx.matterId);
    const clients = fresh.filter((p) => p.role === 'CLIENT').length;
    const adverse = fresh.filter((p) => p.role === 'ADVERSE').length;
    await store.appendAudit(ctx.firmId, ctx.matterId, ctx.userId, 'MATTER_PARTIES_DECLARED', '', { clients, adverse, conflict: r.status, source: 'PARTIES' });
  } catch (e) {
    // no stored party without its check row and audit line
    if (fresh.length) await store.removeParties(ctx.matterId, fresh.map((p) => p.partyId)).catch(() => undefined);
    throw e;
  }
  return { halted: false, light: r.light as Exclude<TrafficLight, 'RED'>, status: r.status, added: fresh.length, counts: await store.counts(ctx.matterId) };
}
