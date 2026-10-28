// Supabase-backed implementations of the pipeline stores. Uses a structural client type so lib/
// has no dependency on @supabase/supabase-js. Every call goes through a service-role-only RPC.

import type { ConflictStore, StoredRow } from '../ai/conflictEngine.ts';
import type { PlaybookRule } from '../ai/domainPlaybookEngine.ts';
import type { RoutingStore } from './auditAndRouting.ts';
import type { CheckRow, PartiesStore, PartyCounts } from './matterParties.ts';
import type { ConflictParty } from '../ai/conflictEngine.ts';

export interface SbResult<T> { data: T | null; error: { message: string } | null }
export interface SbLike {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<SbResult<T>>;
  from(table: string): {
    select(cols: string): { eq(col: string, v: unknown): PromiseLike<SbResult<unknown[]>> };
  };
}

async function call<T>(sb: SbLike, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc<T>(fn, args);
  if (error) throw new Error(`${fn} failed`); // message withheld: it may echo input
  return data as T;
}

export class SupabaseConflictStore implements ConflictStore {
  private sb: SbLike;
  constructor(sb: SbLike) { this.sb = sb; }
  async find(firmId: string, indexes: string[], excludeMatterId?: string): Promise<StoredRow[]> {
    return (await call<StoredRow[]>(this.sb, 'lalum_conflict_find', { p_firm: firmId, p_indexes: indexes, p_exclude_matter: excludeMatterId ?? null })) ?? [];
  }
}

export class SupabaseRoutingStore implements RoutingStore {
  private sb: SbLike;
  constructor(sb: SbLike) { this.sb = sb; }
  provision(payload: Record<string, unknown>) {
    return call<{ matter_id: string; document_id: string; created: boolean }>(this.sb, 'lalum_provision_matter', { p: payload });
  }
  async logHalt(payload: Record<string, unknown>): Promise<void> {
    await call(this.sb, 'lalum_log_conflict_halt', { p: payload });
  }
  async appendAudit(firmId: string, matterId: string | null, userId: string | null, action: string, aiHash: string, meta: Record<string, unknown>): Promise<void> {
    await call(this.sb, 'lalum_append_audit', { p_firm: firmId, p_matter: matterId, p_actor: userId, p_action: action, p_ai_hash: aiHash, p_meta: meta });
  }
}

export function cachedRuleLoader(sb: SbLike, ttlMs = 60_000): () => Promise<PlaybookRule[]> {
  let cache: { at: number; rules: PlaybookRule[] } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.rules;
    const { data, error } = await sb.from('lalum_practice_playbooks').select('*').eq('active', true);
    if (error) throw new Error('playbook load failed');
    cache = { at: Date.now(), rules: (data ?? []) as PlaybookRule[] };
    return cache.rules;
  };
}

/** The table calls of the parties route (service role, so RLS does not apply; the route checked access first). */
export interface SbTableLike {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export class SupabasePartiesStore extends SupabaseConflictStore implements PartiesStore {
  private db: SbTableLike;
  private routing: SupabaseRoutingStore;
  constructor(sb: SbLike & SbTableLike) { super(sb); this.db = sb; this.routing = new SupabaseRoutingStore(sb); }
  private static ok({ error }: SbResult<unknown>, what: string): void { if (error) throw new Error(`${what} failed`); }
  async addParties(firmId: string, matterId: string, parties: ConflictParty[]): Promise<void> {
    const rows = parties.flatMap((p) => p.indexes.map((i) => ({ firm_id: firmId, matter_id: matterId, party_id: p.partyId, role: p.role, kind: i.kind, blind_index: i.blind_index })));
    SupabasePartiesStore.ok(await this.db.from('lalum_conflict_parties').insert(rows), 'party insert');
  }
  async removeParties(matterId: string, partyIds: string[]): Promise<void> {
    SupabasePartiesStore.ok(await this.db.from('lalum_conflict_parties').delete().eq('matter_id', matterId).in('party_id', partyIds), 'party delete');
  }
  async logCheck(row: CheckRow): Promise<void> {
    SupabasePartiesStore.ok(await this.db.from('lalum_conflict_checks').insert(row), 'check insert');
  }
  async raiseToPotential(matterId: string): Promise<void> {
    SupabasePartiesStore.ok(await this.db.from('lalum_cockpit_matters').update({ conflict_status: 'POTENTIAL' }).eq('id', matterId).eq('conflict_status', 'CLEAN'), 'matter update');
  }
  appendAudit(firmId: string, matterId: string | null, userId: string | null, action: string, aiHash: string, meta: Record<string, unknown>): Promise<void> {
    return this.routing.appendAudit(firmId, matterId, userId, action, aiHash, meta);
  }
  private async rows(matterId: string): Promise<Array<{ party_id: string; role: string; kind: string; blind_index: string }>> {
    const r = await this.db.from('lalum_conflict_parties').select('party_id, role, kind, blind_index').eq('matter_id', matterId).in('role', ['CLIENT', 'ADVERSE']);
    SupabasePartiesStore.ok(r, 'party read');
    return r.data ?? [];
  }
  async counts(matterId: string): Promise<PartyCounts> {
    const seen = { CLIENT: new Set<string>(), ADVERSE: new Set<string>() };
    for (const r of await this.rows(matterId)) seen[r.role as keyof PartyCounts]?.add(r.party_id);
    return { CLIENT: seen.CLIENT.size, ADVERSE: seen.ADVERSE.size };
  }
  async declaredOn(matterId: string): Promise<Set<string>> {
    return new Set((await this.rows(matterId)).filter((r) => r.kind !== 'NAME_TOKEN').map((r) => `${r.role}|${r.blind_index}`));
  }
}
