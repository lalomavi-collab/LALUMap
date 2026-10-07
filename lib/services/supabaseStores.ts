// Supabase-backed implementations of the pipeline stores. Uses a structural client type so lib/
// has no dependency on @supabase/supabase-js. Every call goes through a service-role-only RPC.

import type { ConflictStore, StoredRow } from '../ai/conflictEngine.ts';
import type { PlaybookRule } from '../ai/domainPlaybookEngine.ts';
import type { RoutingStore } from './auditAndRouting.ts';

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
