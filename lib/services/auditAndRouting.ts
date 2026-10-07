// Step 4: cryptographic audit event + dual dispatch (partner notification rows and the admin
// control copy). The database does the work in ONE transaction (lalum_provision_matter): matter,
// document, routing, conflict parties, conflict check, hash-chained audit entry and PII-free
// outbox rows. This module builds the payload and hashes the AI output.

import type { Finding, RiskSummary } from '../ai/domainPlaybookEngine.ts';
import type { ConflictParty, ConflictResult } from '../ai/conflictEngine.ts';
import type { PracticeArea, PipelineSource } from '../ai/types.ts';

export interface RoutingStore {
  provision(payload: Record<string, unknown>): Promise<{ matter_id: string; document_id: string; created: boolean }>;
  logHalt(payload: Record<string, unknown>): Promise<void>;
  appendAudit(firmId: string, matterId: string | null, userId: string | null, action: string, aiHash: string, meta: Record<string, unknown>): Promise<void>;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FinalizeInput {
  firmId: string;
  userId: string | null;
  source: PipelineSource;
  matterId?: string;
  title: string;
  fileName: string;
  maskedText: string;
  practiceArea: PracticeArea;
  findings: Finding[];
  risk: RiskSummary;
  conflict: ConflictResult;
  entityCounts: Record<string, number>;
}

export async function aiOutputHash(maskedText: string, findings: Finding[], practiceArea: PracticeArea): Promise<string> {
  return sha256Hex(canonicalJson({ maskedText, practiceArea, findings: findings.map((f) => [f.ruleId, f.severity]) }));
}

export class AuditAndRouting {
  private store: RoutingStore;
  constructor(store: RoutingStore) { this.store = store; }

  async finalize(i: FinalizeInput): Promise<{ matterId: string; documentId: string; aiOutputHash: string }> {
    const hash = await aiOutputHash(i.maskedText, i.findings, i.practiceArea);
    const parties = i.conflict.parties.map((p: ConflictParty) => ({ party_id: p.partyId, role: p.role, indexes: p.indexes }));
    const r = await this.store.provision({
      firm_id: i.firmId,
      user_id: i.userId,
      matter_id: i.matterId ?? null,
      title: i.title,
      practice_area: i.practiceArea,
      conflict_status: i.conflict.status,
      source: i.source,
      risk_summary: i.risk,
      document: {
        file_name: i.fileName,
        masked_content: i.maskedText,
        entity_counts: i.entityCounts,
        analysis: { findings: i.findings, risk: i.risk },
      },
      parties,
      conflict: { reason_codes: i.conflict.reasonCodes, match_count: i.conflict.matchCount, entity_count: i.conflict.entityCount },
      audit: { ai_output_hash: hash, meta: { source: i.source, practice_area: i.practiceArea, risk_level: i.risk.level, red: i.risk.red, yellow: i.risk.yellow, entities: i.conflict.entityCount } },
    });
    return { matterId: r.matter_id, documentId: r.document_id, aiOutputHash: hash };
  }

  async halt(firmId: string, userId: string | null, source: PipelineSource, c: ConflictResult): Promise<void> {
    await this.store.logHalt({ firm_id: firmId, user_id: userId, source, reason_codes: c.reasonCodes, match_count: c.matchCount, entity_count: c.entityCount });
  }
}
