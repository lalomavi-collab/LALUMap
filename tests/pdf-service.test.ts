import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePdfRequest } from '../lib/services/pdf/pdfService.ts';

const calls: Array<{ url: string; headers: Record<string, string> }> = [];
const mk = (status = 200) => ({
  edgeBase: 'https://x.test/functions/v1', anonKey: 'anon',
  fetchImpl: async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, headers: init.headers }); return { status, text: async () => '<html></html>' }; },
  render: async () => new TextEncoder().encode('%PDF-1.4 fake'),
});
const ID = '3f2b8c1e-0000-4000-8000-123456789abc';

test('forwards the caller JWT and only whitelisted params, returns a PDF', async () => {
  calls.length = 0;
  const r = await handlePdfRequest(`/pdf?kind=bill&id=${ID}&court_case=${encodeURIComponent('12345-01-26')}&evil=1`, 'Bearer jwt', mk());
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'application/pdf');
  assert.equal(calls[0]!.headers.authorization, 'Bearer jwt');
  assert.match(calls[0]!.url, /^https:\/\/x\.test\/functions\/v1\/lalum-billing-doc\?kind=bill&id=/);
  assert.doesNotMatch(calls[0]!.url, /evil/);
});
test('rejects missing JWT, bad kind and bad id before any upstream call', async () => {
  calls.length = 0;
  assert.equal((await handlePdfRequest(`/pdf?kind=bill&id=${ID}`, undefined, mk())).status, 401);
  assert.equal((await handlePdfRequest(`/pdf?kind=x&id=${ID}`, 'Bearer j', mk())).status, 400);
  assert.equal((await handlePdfRequest('/pdf?kind=bill&id=../../etc', 'Bearer j', mk())).status, 400);
  assert.equal((await handlePdfRequest('/other', 'Bearer j', mk())).status, 404);
  assert.equal(calls.length, 0);
});
test('upstream denial is passed through, other failures become 502', async () => {
  assert.equal((await handlePdfRequest(`/pdf?kind=trust&id=7`, 'Bearer j', mk(403))).status, 403);
  assert.equal((await handlePdfRequest(`/pdf?kind=trust&id=7`, 'Bearer j', mk(500))).status, 502);
});
