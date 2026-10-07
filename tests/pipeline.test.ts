import test from 'node:test';
import assert from 'node:assert/strict';
import { MemDb, makeAgent } from './helpers.ts';
import { NEUTRAL_REJECTION_MESSAGE } from '../lib/ai/conflictEngine.ts';
import { analyze, detectPracticeArea } from '../lib/ai/domainPlaybookEngine.ts';
import { RULES } from './helpers.ts';

const ctx = { firmId: 'F1', userId: 'u1' };
const CLIENT = [{ name: 'ישראל ישראלי', role: 'CLIENT' as const, idNumber: '000000018' }];
const ADVERSE = [{ name: 'ישראל ישראלי', role: 'ADVERSE' as const }];

test('happy path provisions a matter with masked content only', async () => {
  const db = new MemDb();
  const r = await makeAgent(db).process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'הסכם תמ"א 38 עם הדיירים. ישראל ישראלי ת.ז. 000000018 גוש 6158 חלקה 25. דירה ויזם.', fileName: 'הסכם ישראל ישראלי.docx', parties: CLIENT }, ctx);
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  assert.equal(r.practiceArea, 'REAL_ESTATE');
  assert.equal(r.risk.level, 'HIGH_RISK'); // no guarantee clause
  assert.equal(db.provisioned.length, 1);
  const stored = JSON.stringify(db.provisioned[0]);
  for (const raw of ['ישראלי', '000000018', '6158']) assert.ok(!stored.includes(raw), `leaked ${raw}`);
  assert.ok(db.provisioned[0].parties.length >= 1);
});

test('RED conflict halts with the neutral message and provisions nothing', async () => {
  const db = new MemDb();
  const agent = makeAgent(db);
  await agent.process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'חוזה עם ישראל ישראלי', parties: CLIENT }, ctx);
  const r = await agent.process({ source: 'INTAKE_WEBHOOK', kind: 'INTAKE_MESSAGE', text: 'תביעה נגד ישראל ישראלי', parties: ADVERSE }, ctx);
  assert.equal(r.status, 'HALTED_CONFLICT');
  if (r.status === 'HALTED_CONFLICT') assert.equal(r.message, NEUTRAL_REJECTION_MESSAGE);
  assert.equal(db.provisioned.length, 1); // only the first
  assert.equal(db.halts.length, 1);
  assert.ok(!JSON.stringify(r).includes('ישראלי'));
  assert.deepEqual(db.halts[0].reason_codes, ['ADVERSE_IS_ACTIVE_CLIENT']);
});

test('conflict lookups never cross firms (tenant isolation)', async () => {
  const db = new MemDb();
  await makeAgent(db).process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'חוזה', parties: CLIENT }, ctx);
  const r = await makeAgent(db).process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'תביעה', parties: ADVERSE }, { firmId: 'F2', userId: 'u2' });
  assert.equal(r.status, 'OK');
});

test('same side match (returning client) is GREEN; unknown role match is YELLOW', async () => {
  const db = new MemDb();
  const agent = makeAgent(db);
  await agent.process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'חוזה', parties: CLIENT }, ctx);
  const again = await agent.process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'חוזה נוסף', parties: CLIENT }, ctx);
  assert.equal(again.status === 'OK' && again.conflict, 'GREEN');
  const unk = await agent.process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'מסמך שבו מר ישראל ישראלי מופיע' }, ctx);
  assert.equal(unk.status === 'OK' && unk.conflict, 'YELLOW');
});

test('ID match alone is a strong match', async () => {
  const db = new MemDb();
  const agent = makeAgent(db);
  await agent.process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'חוזה', parties: CLIENT }, ctx);
  const r = await agent.process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'נתבע בשם אחר', parties: [{ name: 'שם אחר לגמרי', role: 'ADVERSE', idNumber: '000000018' }] }, ctx);
  assert.equal(r.status, 'HALTED_CONFLICT');
});

test('suspended firm is refused before anything runs', async () => {
  const db = new MemDb();
  await assert.rejects(() => makeAgent(db, { status: 'SUSPENDED' }).process({ source: 'UPLOAD', kind: 'FILE_TEXT', text: 'x' }, ctx), /not active/);
});

test('chat prompts are masked and audited but never provision a matter', async () => {
  const db = new MemDb();
  const r = await makeAgent(db).process({ source: 'CHAT', kind: 'CHAT_PROMPT', text: 'נסח מייל ל-dan@example.co.il על שכר גלובלי' }, ctx);
  assert.equal(r.status === 'OK' && r.maskedText.includes('example'), false);
  assert.equal(db.provisioned.length, 0);
  assert.equal(db.audits[0].action, 'CHAT_PIPELINE_PASS');
});

test('playbook: ABSENT fires, PRESENT with unless is suppressed, broken regex is skipped', () => {
  const a = analyze('הסכם. הדייר מוותר על כל טענה.', RULES, 'REAL_ESTATE');
  const bySev = Object.fromEntries(a.findings.map((f) => [f.ruleId, f.severity]));
  assert.equal(bySev.r1, 'RED');
  assert.equal(bySev.r2, 'YELLOW');
  assert.equal(a.rulesSkipped, 1);
  assert.equal(a.risk.level, 'HIGH_RISK');
  assert.equal(a.risk.score, 65);
  const f2 = a.findings.find((f) => f.ruleId === 'r2')!;
  assert.ok(f2.span && f2.excerpt!.includes('מוותר'));
  const l = analyze('שכר גלובלי הכולל 20 שעות נוספות', RULES, 'LABOR_LAW');
  assert.equal(l.findings[0].severity, 'GREEN');
  assert.equal(analyze('שכר גלובלי', RULES, 'LABOR_LAW').findings[0].severity, 'YELLOW');
});

test('practice area detection', () => {
  assert.equal(detectPracticeArea('הסכם עבודה עם עובד, שכר ושעות נוספות והודעה מוקדמת').area, 'LABOR_LAW');
  assert.equal(detectPracticeArea('שלום').area, 'COMMERCIAL_MA');
  assert.equal(detectPracticeArea('כתב תביעה לבית משפט, התובע והנתבע, תצהיר').area, 'LITIGATION');
});
