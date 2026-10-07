// AutomatedPipelineAgent: every payload goes through the same four steps, in order, and any
// failure stops the request (fail closed): nothing is forwarded to an external LLM unless
// process() returned status OK.
//   1 PII shield  ->  2 conflict check  ->  3 domain playbook  ->  4 audit and dual dispatch

import { EphemeralVault } from '../crypto/ephemeralVault.ts';
import { AuditAndRouting, aiOutputHash } from '../services/auditAndRouting.ts';
import type { RoutingStore } from '../services/auditAndRouting.ts';
import { LalumAnonymizerProxy } from './anonymizerProxy.ts';
import { ConflictEngine } from './conflictEngine.ts';
import type { ConflictStore } from './conflictEngine.ts';
import { analyze, detectPracticeArea } from './domainPlaybookEngine.ts';
import type { Finding, PlaybookRule, RiskSummary } from './domainPlaybookEngine.ts';
import { PipelineError } from './types.ts';
import type { ConflictStatus, DeclaredParty, PipelineSource, PracticeArea, PublicEntity, TrafficLight } from './types.ts';

export type PipelineKind = 'FILE_TEXT' | 'INTAKE_MESSAGE' | 'CHAT_PROMPT';

export interface PipelineInput {
  source: PipelineSource;
  kind: PipelineKind;
  text: string;
  fileName?: string;
  title?: string;
  matterId?: string;
  parties?: DeclaredParty[];
  declaredPracticeArea?: PracticeArea;
}

export interface PipelineContext { firmId: string; userId: string | null }

export interface PipelineDeps {
  conflictStore: ConflictStore;
  routingStore: RoutingStore;
  loadRules(): Promise<PlaybookRule[]>;
  firmConflictKey(firmId: string): Promise<string>;
  firmStatus(firmId: string): Promise<string | null>;
  allowlist?: string[];
}

export type PipelineResult =
  | { status: 'HALTED_CONFLICT'; conflict: 'RED'; message: string }
  | {
      status: 'OK';
      conflict: Exclude<TrafficLight, 'RED'>;
      conflictStatus: ConflictStatus;
      maskedText: string;
      maskedTitle: string;
      entities: PublicEntity[];
      counts: Record<string, number>;
      needsReview: number;
      practiceArea: PracticeArea;
      findings: Finding[];
      risk: RiskSummary;
      aiOutputHash: string;
      matterId?: string;
      documentId?: string;
    };

export class AutomatedPipelineAgent {
  private deps: PipelineDeps;
  constructor(deps: PipelineDeps) { this.deps = deps; }

  async process(input: PipelineInput, ctx: PipelineContext): Promise<PipelineResult> {
    if (!input.text || !input.text.trim()) throw new PipelineError('EMPTY_INPUT', 'Empty payload');
    if (input.text.length > 1_500_000) throw new PipelineError('TOO_LARGE', 'Payload too large');
    if ((await this.deps.firmStatus(ctx.firmId)) !== 'ACTIVE') throw new PipelineError('FIRM_INACTIVE', 'Firm subscription is not active');

    const vault = await EphemeralVault.create();
    try {
      // STEP 1: PII shield
      const shield = new LalumAnonymizerProxy({ vault, parties: input.parties, allowlist: this.deps.allowlist });
      for (const s of [input.text, input.title ?? '', input.fileName ?? '']) shield.reserveFrom(s);
      const body = await shield.anonymize(input.text);
      const titleSource = input.title?.trim() || input.fileName?.trim() || input.text.trim().split('\n')[0].slice(0, 80);
      const title = await shield.anonymize(titleSource);
      const file = await shield.anonymize(input.fileName?.trim() || titleSource);

      // STEP 2: conflict check (halts before anything else happens)
      const engine = new ConflictEngine(this.deps.conflictStore, await this.deps.firmConflictKey(ctx.firmId));
      const detections = [...body.detections, ...title.detections];
      const conflict = await engine.check(ctx.firmId, input.parties ?? [], detections, { excludeMatterId: input.matterId });
      const audit = new AuditAndRouting(this.deps.routingStore);
      if (conflict.halted) {
        await audit.halt(ctx.firmId, ctx.userId, input.source, conflict);
        return { status: 'HALTED_CONFLICT', conflict: 'RED', message: conflict.neutralMessage! };
      }

      // STEP 3: domain playbook and risk scoring (masked text only)
      const area = detectPracticeArea(body.masked, input.declaredPracticeArea).area;
      const { findings, risk } = analyze(body.masked, await this.deps.loadRules(), area);
      const hash = await aiOutputHash(body.masked, findings, area);

      // STEP 4: audit trail and dual dispatch
      let matterId: string | undefined;
      let documentId: string | undefined;
      if (input.kind === 'CHAT_PROMPT') {
        await this.deps.routingStore.appendAudit(ctx.firmId, null, ctx.userId, 'CHAT_PIPELINE_PASS', hash, { entities: conflict.entityCount, practice_area: area, risk_level: risk.level });
      } else {
        const r = await audit.finalize({
          firmId: ctx.firmId, userId: ctx.userId, source: input.source, matterId: input.matterId,
          title: title.masked.slice(0, 200), fileName: file.masked.slice(0, 200), maskedText: body.masked,
          practiceArea: area, findings, risk, conflict, entityCounts: body.counts as Record<string, number>,
        });
        matterId = r.matterId; documentId = r.documentId;
      }

      return {
        status: 'OK',
        conflict: conflict.light === 'YELLOW' ? 'YELLOW' : 'GREEN',
        conflictStatus: conflict.status,
        maskedText: body.masked,
        maskedTitle: title.masked,
        entities: body.entities,
        counts: body.counts as Record<string, number>,
        needsReview: body.needsReview,
        practiceArea: area,
        findings,
        risk,
        aiOutputHash: hash,
        matterId,
        documentId,
      };
    } finally {
      vault.dispose(); // Zero Data Retention: the token map dies with the request
    }
  }
}
