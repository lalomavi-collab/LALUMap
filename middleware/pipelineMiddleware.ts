// Framework-agnostic interception layer (Web Request/Response, so it works in a Next.js route
// handler, Next middleware helper, or the Supabase edge function). Every payload on a protected
// route goes through AutomatedPipelineAgent.process() BEFORE the downstream handler (which is the
// only code allowed to call an external LLM) runs. A pipeline failure never falls through.

import { AutomatedPipelineAgent } from '../lib/ai/automatedPipelineAgent.ts';
import type { PipelineInput, PipelineKind, PipelineResult } from '../lib/ai/automatedPipelineAgent.ts';
import { PiiLeakError, PipelineError } from '../lib/ai/types.ts';
import type { PipelineSource } from '../lib/ai/types.ts';

export interface RouteRule { suffix: string; source: PipelineSource; kind: PipelineKind; authMode: 'user' | 'intake_token'; haltStatus: number }

export const PROTECTED_ROUTES: RouteRule[] = [
  { suffix: '/api/v1/documents/upload', source: 'UPLOAD', kind: 'FILE_TEXT', authMode: 'user', haltStatus: 409 },
  { suffix: '/api/v1/intake/webhook', source: 'INTAKE_WEBHOOK', kind: 'INTAKE_MESSAGE', authMode: 'intake_token', haltStatus: 200 }, // 200: webhooks retry on non-2xx
  { suffix: '/api/v1/chat', source: 'CHAT', kind: 'CHAT_PROMPT', authMode: 'user', haltStatus: 409 },
];

export interface AuthResult { firmId: string; userId: string | null }
export interface MiddlewareDeps {
  agent: AutomatedPipelineAgent;
  authenticate(req: Request, rule: RouteRule): Promise<AuthResult | null>;
  headers?: Record<string, string>;
}
export interface PipelineHandlerArgs { req: Request; auth: AuthResult; input: PipelineInput; result: Extract<PipelineResult, { status: 'OK' }>; body: Record<string, unknown> }
export type PipelineHandler = (a: PipelineHandlerArgs) => Promise<Response>;

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

export function matchRoute(pathname: string): RouteRule | null {
  return PROTECTED_ROUTES.find((r) => pathname.endsWith(r.suffix)) ?? null;
}

export function withPipeline(deps: MiddlewareDeps, handler: PipelineHandler) {
  return async function handle(req: Request): Promise<Response> {
    const h = deps.headers ?? {};
    const rule = matchRoute(new URL(req.url).pathname);
    if (!rule) return json(404, { ok: false, code: 'NOT_FOUND' }, h);
    if (req.method !== 'POST') return json(405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, h);
    const auth = await deps.authenticate(req, rule).catch(() => null);
    if (!auth) return json(401, { ok: false, code: 'UNAUTHENTICATED' }, h);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json(400, { ok: false, code: 'BAD_JSON' }, h); }
    const text = String(body.text ?? body.prompt ?? body.message ?? '');
    const input: PipelineInput = {
      source: rule.source,
      kind: rule.kind,
      text,
      fileName: typeof body.file_name === 'string' ? body.file_name : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      matterId: typeof body.matter_id === 'string' ? body.matter_id : undefined,
      parties: Array.isArray(body.parties) ? (body.parties as PipelineInput['parties']) : undefined,
      declaredPracticeArea: typeof body.practice_area === 'string' ? (body.practice_area as PipelineInput['declaredPracticeArea']) : undefined,
    };

    try {
      const result = await deps.agent.process(input, auth);
      if (result.status === 'HALTED_CONFLICT') {
        return json(rule.haltStatus, { ok: false, code: 'CONFLICT_HALT', message: result.message }, h);
      }
      return await handler({ req, auth, input, result, body });
    } catch (e) {
      // Never echo detail: it could contain what we were trying to protect.
      if (e instanceof PiiLeakError) return json(422, { ok: false, code: 'PII_LEAK_BLOCKED' }, h);
      if (e instanceof PipelineError) return json(e.code === 'FIRM_INACTIVE' ? 402 : e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, code: e.code }, h);
      console.error('pipeline middleware failure', (e as Error)?.name);
      return json(503, { ok: false, code: 'PIPELINE_UNAVAILABLE' }, h);
    }
  };
}
