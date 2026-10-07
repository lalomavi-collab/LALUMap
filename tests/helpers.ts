import { AutomatedPipelineAgent } from '../lib/ai/automatedPipelineAgent.ts';
import type { PipelineDeps } from '../lib/ai/automatedPipelineAgent.ts';
import type { ConflictStore, StoredRow } from '../lib/ai/conflictEngine.ts';
import type { PlaybookRule } from '../lib/ai/domainPlaybookEngine.ts';
import type { RoutingStore } from '../lib/services/auditAndRouting.ts';

export const KEY_A = 'aa'.repeat(32);
export const KEY_B = 'bb'.repeat(32);

export class MemDb implements ConflictStore, RoutingStore {
  rows: Array<StoredRow & { firm: string; matter: string }> = [];
  provisioned: Array<Record<string, any>> = [];
  halts: Array<Record<string, any>> = [];
  audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
  async find(firmId: string, indexes: string[], exclude?: string): Promise<StoredRow[]> {
    return this.rows.filter((r) => r.firm === firmId && indexes.includes(r.blind_index) && r.matter !== exclude);
  }
  async provision(p: Record<string, any>) {
    const matter_id = p.matter_id ?? crypto.randomUUID();
    this.provisioned.push(p);
    for (const party of p.parties) for (const ix of party.indexes) {
      this.rows.push({ firm: p.firm_id, matter: matter_id, party_id: party.party_id, role: party.role, kind: ix.kind, blind_index: ix.blind_index, matter_active: true });
    }
    return { matter_id, document_id: crypto.randomUUID(), created: !p.matter_id };
  }
  async logHalt(p: Record<string, any>) { this.halts.push(p); }
  async appendAudit(_f: string, _m: string | null, _u: string | null, action: string, _h: string, meta: Record<string, unknown>) { this.audits.push({ action, meta }); }
}

export const RULES: PlaybookRule[] = [
  { id: 'r1', practice_area: 'REAL_ESTATE', rule_name: 'ערבות', severity: 'RED', mode: 'ABSENT', pattern: 'ערבות\\s+(בנקאית|ביטוחית)', unless_pattern: null, description: 'חסרה ערבות', fallback_clause: 'ערבות בנקאית [__]', source_citation: 'חוק המכר (דירות)', source_url: null },
  { id: 'r2', practice_area: 'REAL_ESTATE', rule_name: 'ויתור', severity: 'YELLOW', mode: 'PRESENT', pattern: 'מוותר\\s+על\\s+כל\\s+טענה', unless_pattern: null, description: 'ויתור רחב', fallback_clause: 'ויתור מוגבל', source_citation: null, source_url: null },
  { id: 'r3', practice_area: 'LABOR_LAW', rule_name: 'גלובלי', severity: 'YELLOW', mode: 'PRESENT', pattern: 'שכר\\s+גלובלי', unless_pattern: '\\d+\\s+שעות\\s+נוספות', description: 'גלובלי', fallback_clause: 'x', source_citation: null, source_url: null },
  { id: 'bad', practice_area: 'REAL_ESTATE', rule_name: 'broken', severity: 'RED', mode: 'ABSENT', pattern: '([', unless_pattern: null, description: '', fallback_clause: '', source_citation: null, source_url: null },
];

export function makeAgent(db: MemDb, opts: { status?: string; keys?: Record<string, string> } = {}) {
  const deps: PipelineDeps = {
    conflictStore: db,
    routingStore: db,
    loadRules: async () => RULES,
    firmConflictKey: async (f) => (opts.keys ?? { F1: KEY_A, F2: KEY_B })[f] ?? KEY_A,
    firmStatus: async () => opts.status ?? 'ACTIVE',
  };
  return new AutomatedPipelineAgent(deps);
}
