// Edge function: LALUM automated pipeline gateway.
//   POST /api/v1/documents/upload   (user JWT)   file text through the 4-step pipeline, provisions the matter
//   POST /api/v1/intake/webhook     (firm token) intake messages, same pipeline, neutral reply on conflict
//   POST /api/v1/chat               (user JWT)   masked prompt forwarded to the pii-gateway LLM proxy
//   POST /api/v1/documents/draft    (user JWT)   re-masks and saves the editor draft
//   POST /api/v1/documents/analyze  (user JWT)   re-runs the playbook for a chosen practice area on masked text
//   POST /api/v1/documents/export   (user JWT)   returns content only after the 4-step sign-off is valid
// Base URL: /functions/v1/lalum-pipeline . verify_jwt is OFF at the platform level because the intake
// webhook has no user JWT; every route authenticates itself below and fails closed.
// deno-lint-ignore-file no-explicit-any
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AutomatedPipelineAgent } from '../../../lib/ai/automatedPipelineAgent.ts';
import { EphemeralVault } from '../../../lib/crypto/ephemeralVault.ts';
import { LalumAnonymizerProxy } from '../../../lib/ai/anonymizerProxy.ts';
import { PiiLeakError, PRACTICE_AREAS } from '../../../lib/ai/types.ts';
import type { PracticeArea } from '../../../lib/ai/types.ts';
import { analyze } from '../../../lib/ai/domainPlaybookEngine.ts';
import { sha256Hex } from '../../../lib/services/auditAndRouting.ts';
import { SupabaseConflictStore, SupabaseRoutingStore, cachedRuleLoader } from '../../../lib/services/supabaseStores.ts';
import { withPipeline } from '../../../middleware/pipelineMiddleware.ts';
import type { RouteRule } from '../../../middleware/pipelineMiddleware.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb: any = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const ALLOWED_ORIGINS = new Set(['https://lalumapp.com', 'https://www.lalumapp.com', 'http://localhost:3000', 'http://localhost:8080']);
const corsFor = (req: Request): Record<string, string> => {
  const o = req.headers.get('origin') ?? '';
  return {
    'access-control-allow-origin': ALLOWED_ORIGINS.has(o) ? o : 'https://lalumapp.com',
    'access-control-allow-headers': 'authorization, content-type, x-lalum-firm, apikey, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
};
const json = (req: Request, status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsFor(req) } });

const agent = new AutomatedPipelineAgent({
  conflictStore: new SupabaseConflictStore(sb),
  routingStore: new SupabaseRoutingStore(sb),
  loadRules: cachedRuleLoader(sb),
  firmConflictKey: async (firmId) => {
    const { data, error } = await sb.rpc('lalum_firm_conflict_key', { p_firm: firmId });
    if (error || !data) throw new Error('firm key unavailable');
    return data as string;
  },
  firmStatus: async (firmId) => {
    const { data } = await sb.rpc('lalum_firm_status', { p_firm: firmId });
    return (data as string | null) ?? null;
  },
  allowlist: ['אברהם ללום', 'Avraham Lalum'],
});

async function userFromRequest(req: Request): Promise<{ firmId: string; userId: string; role: string } | null> {
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: m } = await sb.rpc('lalum_user_firm', { p_user: data.user.id });
  if (!m?.firm_id) return null;
  return { firmId: m.firm_id, userId: data.user.id, role: m.role };
}

async function authenticate(req: Request, rule: RouteRule) {
  if (rule.authMode === 'user') {
    const u = await userFromRequest(req);
    return u ? { firmId: u.firmId, userId: u.userId } : null;
  }
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const firm = req.headers.get('x-lalum-firm') ?? '';
  if (!/^lit_[0-9a-f]{48}$/.test(token) || !/^[0-9a-f-]{36}$/.test(firm)) return null;
  const { data } = await sb.rpc('lalum_verify_intake_token', { p_firm: firm, p_token_hash: await sha256Hex(token) });
  return data === true ? { firmId: firm, userId: null } : null;
}

const pipelineRoute = withPipeline({ agent, authenticate, headers: {} }, async ({ req, result, input, body }) => {
  const base = {
    ok: true,
    conflict: result.conflict,
    practice_area: result.practiceArea,
    masked_text: result.maskedText,
    masked_title: result.maskedTitle,
    entities: result.entities,
    counts: result.counts,
    needs_review: result.needsReview,
    findings: result.findings,
    risk: result.risk,
    matter_id: result.matterId ?? null,
    document_id: result.documentId ?? null,
    ai_output_hash: result.aiOutputHash,
  };
  if (input.kind !== 'CHAT_PROMPT') return json(req, 200, base);

  // Chat: only the masked prompt may travel on, and only through the PII gateway.
  const history = Array.isArray(body.history) ? (body.history as Array<{ role: string; content: string }>) : [];
  const vault = await EphemeralVault.create();
  try {
    const shield = new LalumAnonymizerProxy({ vault });
    for (const h of history) shield.assertClean(String(h.content)); // client must send already-masked history
  } catch (e) {
    if (e instanceof PiiLeakError) return json(req, 422, { ok: false, code: 'PII_LEAK_BLOCKED' });
    throw e;
  } finally { vault.dispose(); }
  const messages = [...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) })), { role: 'user', content: result.maskedText }];
  const up = await fetch(`${URL_}/functions/v1/pii-gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': SERVICE, 'x-lalum-surface': 'cockpit-chat' },
    body: JSON.stringify({ model: Deno.env.get('LALUM_CHAT_MODEL') ?? 'claude-sonnet-5-5', max_tokens: 1500, messages }),
  });
  if (!up.ok) return json(req, 502, { ...base, ok: false, code: 'LLM_UNAVAILABLE', reply: null });
  const msg = await up.json();
  const reply = (msg.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return json(req, 200, { ...base, reply });
});

async function draftRoute(req: Request): Promise<Response> {
  const u = await userFromRequest(req);
  if (!u) return json(req, 401, { ok: false, code: 'UNAUTHENTICATED' });
  const { document_id, content } = await req.json().catch(() => ({}));
  if (typeof document_id !== 'string' || typeof content !== 'string' || content.length > 1_500_000) return json(req, 400, { ok: false, code: 'BAD_REQUEST' });
  const vault = await EphemeralVault.create();
  try {
    const shield = new LalumAnonymizerProxy({ vault });
    shield.reserveFrom(content);
    const masked = (await shield.anonymize(content)).masked; // already-masked text passes through unchanged
    const { error } = await sb.rpc('lalum_save_draft', { p_doc: document_id, p_firm: u.firmId, p_content: masked });
    if (error) return json(req, 404, { ok: false, code: 'NOT_FOUND' });
    return json(req, 200, { ok: true, saved_text: masked, changed: masked !== content });
  } catch (e) {
    if (e instanceof PiiLeakError) return json(req, 422, { ok: false, code: 'PII_LEAK_BLOCKED' });
    throw e;
  } finally { vault.dispose(); }
}


const loadRules = cachedRuleLoader(sb);
async function analyzeRoute(req: Request): Promise<Response> {
  const u = await userFromRequest(req);
  if (!u) return json(req, 401, { ok: false, code: 'UNAUTHENTICATED' });
  const { text, practice_area } = await req.json().catch(() => ({}));
  if (typeof text !== 'string' || text.length > 1_500_000 || !PRACTICE_AREAS.includes(practice_area)) return json(req, 400, { ok: false, code: 'BAD_REQUEST' });
  const vault = await EphemeralVault.create();
  try {
    new LalumAnonymizerProxy({ vault }).assertClean(text); // only masked text may be analysed
    const a = analyze(text, await loadRules(), practice_area as PracticeArea);
    return json(req, 200, { ok: true, practice_area, findings: a.findings, risk: a.risk });
  } catch (e) {
    if (e instanceof PiiLeakError) return json(req, 422, { ok: false, code: 'PII_LEAK_BLOCKED' });
    throw e;
  } finally { vault.dispose(); }
}

async function exportRoute(req: Request): Promise<Response> {
  const u = await userFromRequest(req);
  if (!u) return json(req, 401, { ok: false, code: 'UNAUTHENTICATED' });
  const { document_id } = await req.json().catch(() => ({}));
  if (typeof document_id !== 'string') return json(req, 400, { ok: false, code: 'BAD_REQUEST' });
  const { data: doc } = await sb.from('lalum_matter_documents').select('file_name, editor_content, firm_id').eq('id', document_id).maybeSingle();
  if (!doc || doc.firm_id !== u.firmId) return json(req, 404, { ok: false, code: 'NOT_FOUND' });
  const { data: signed } = await sb.rpc('lalum_doc_signed_off', { p_doc: document_id });
  if (signed !== true) return json(req, 403, { ok: false, code: 'SIGN_OFF_REQUIRED' }); // the gate: content is withheld
  await sb.rpc('lalum_log_export', { p_doc: document_id, p_firm: u.firmId, p_user: u.userId });
  return json(req, 200, { ok: true, file_name: doc.file_name, content: doc.editor_content });
}

// Static synthetic probe: proves the deployed masking code behaves like the repository's (no caller input, no data).
const PROBE = 'מר דוד כהן, ת.ז. 123456782, טלפון 052-123-4567, דוא"ל test.person@example.test, ברחוב הרצל 15, חשבון בנק 12-345-678901';

Deno.serve(async (req: Request) => {
  if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/selftest')) {
    const v = await EphemeralVault.create();
    try { return new Response(JSON.stringify({ masked: (await new LalumAnonymizerProxy({ vault: v }).anonymize(PROBE)).masked }), { headers: { 'content-type': 'application/json; charset=utf-8' } }); } finally { v.dispose(); }
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(req) });
  const path = new URL(req.url).pathname;
  try {
    let res: Response;
    if (path.endsWith('/api/v1/documents/draft')) res = await draftRoute(req);
    else if (path.endsWith('/api/v1/documents/analyze')) res = await analyzeRoute(req);
    else if (path.endsWith('/api/v1/documents/export')) res = await exportRoute(req);
    else res = await pipelineRoute(req);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsFor(req))) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  } catch (e) {
    console.error('lalum-pipeline error', (e as Error)?.name);
    return json(req, 503, { ok: false, code: 'PIPELINE_UNAVAILABLE' });
  }
});
