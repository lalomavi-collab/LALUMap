import test from 'node:test';
import assert from 'node:assert/strict';
import { MemDb, makeAgent } from './helpers.ts';
import { withPipeline } from '../middleware/pipelineMiddleware.ts';

const call = (h: (r: Request) => Promise<Response>, path: string, body: unknown, method = 'POST') =>
  h(new Request(`https://x.test${path}`, { method, body: method === 'POST' ? JSON.stringify(body) : undefined }));

test('downstream handler only ever sees masked text; unauth and unknown routes never reach it', async () => {
  const db = new MemDb();
  let seen = '';
  const handle = withPipeline(
    { agent: makeAgent(db), authenticate: async () => ({ firmId: 'F1', userId: 'u' }) },
    async ({ result }) => { seen = result.maskedText; return new Response('ok'); },
  );
  const res = await call(handle, '/functions/v1/lalum-pipeline/api/v1/chat', { prompt: 'שלח ל-a@b.co' });
  assert.equal(res.status, 200);
  assert.equal(seen, 'שלח ל-[EMAIL_1]');
  assert.equal((await call(handle, '/api/v1/other', {})).status, 404);
  assert.equal((await call(handle, '/api/v1/chat', {}, 'GET')).status, 405);
  assert.equal((await call(handle, '/api/v1/chat', { prompt: '  ' })).status, 400);

  const noAuth = withPipeline({ agent: makeAgent(db), authenticate: async () => null }, async () => { throw new Error('must not run'); });
  assert.equal((await call(noAuth, '/api/v1/chat', { prompt: 'x' })).status, 401);
});

test('pipeline failure fails closed (503) and the handler never runs', async () => {
  const db = new MemDb();
  db.find = async () => { throw new Error('db down'); };
  let ran = false;
  const handle = withPipeline({ agent: makeAgent(db), authenticate: async () => ({ firmId: 'F1', userId: 'u' }) }, async () => { ran = true; return new Response('ok'); });
  const res = await call(handle, '/api/v1/documents/upload', { text: 'מר דוד כהן ת.ז. 000000018' });
  assert.equal(res.status, 503);
  assert.equal(ran, false);
});

test('webhook conflict halt answers 200 with the neutral message, upload answers 409', async () => {
  const db = new MemDb();
  const agent = makeAgent(db);
  const handle = withPipeline({ agent, authenticate: async () => ({ firmId: 'F1', userId: null }) }, async () => new Response('ok'));
  await call(handle, '/api/v1/documents/upload', { text: 'חוזה', parties: [{ name: 'דוד כהן', role: 'CLIENT' }] });
  const w = await call(handle, '/api/v1/intake/webhook', { text: 'נגד דוד כהן', parties: [{ name: 'דוד כהן', role: 'ADVERSE' }] });
  assert.equal(w.status, 200);
  const j = await w.json();
  assert.equal(j.ok, false); assert.equal(j.code, 'CONFLICT_HALT');
  const u = await call(handle, '/api/v1/documents/upload', { text: 'נגד דוד כהן', parties: [{ name: 'דוד כהן', role: 'ADVERSE' }] });
  assert.equal(u.status, 409);
});
