import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY_A } from './helpers.ts';
import { NEUTRAL_REJECTION_MESSAGE } from '../lib/ai/conflictEngine.ts';
import type { ConflictParty, StoredRow } from '../lib/ai/conflictEngine.ts';
import { declareParties, parseParties, MAX_PARTIES } from '../lib/services/matterParties.ts';
import type { CheckRow, PartiesStore, PartyCounts } from '../lib/services/matterParties.ts';

// All names and numbers are invented.
class MemParties implements PartiesStore {
  rows: Array<StoredRow & { firm: string; matter: string }> = [];
  checks: CheckRow[] = [];
  audits: Array<{ matter: string | null; action: string; meta: Record<string, unknown> }> = [];
  status = new Map<string, string>();
  failAudit = false;
  async find(firmId: string, indexes: string[], exclude?: string): Promise<StoredRow[]> {
    return this.rows.filter((r) => r.firm === firmId && indexes.includes(r.blind_index) && r.matter !== exclude);
  }
  async addParties(firmId: string, matterId: string, parties: ConflictParty[]) {
    for (const p of parties) for (const i of p.indexes) this.rows.push({ firm: firmId, matter: matterId, party_id: p.partyId, role: p.role, kind: i.kind, blind_index: i.blind_index, matter_active: true });
  }
  async removeParties(matterId: string, ids: string[]) { this.rows = this.rows.filter((r) => !(r.matter === matterId && ids.includes(r.party_id))); }
  async logCheck(row: CheckRow) { this.checks.push(row); }
  async raiseToPotential(matterId: string) { if ((this.status.get(matterId) ?? 'CLEAN') === 'CLEAN') this.status.set(matterId, 'POTENTIAL'); }
  async appendAudit(_f: string, matter: string | null, _u: string | null, action: string, _h: string, meta: Record<string, unknown>) {
    if (this.failAudit) throw new Error('audit down');
    this.audits.push({ matter, action, meta });
  }
  async counts(matterId: string): Promise<PartyCounts> {
    const ids = (role: string) => new Set(this.rows.filter((r) => r.matter === matterId && r.role === role).map((r) => r.party_id)).size;
    return { CLIENT: ids('CLIENT'), ADVERSE: ids('ADVERSE') };
  }
  async declaredOn(matterId: string) {
    return new Set(this.rows.filter((r) => r.matter === matterId && r.kind !== 'NAME_TOKEN' && r.role !== 'OTHER').map((r) => `${r.role}|${r.blind_index}`));
  }
}

const ctx = (matterId: string) => ({ firmId: 'F1', userId: 'u1', matterId });

test('parseParties accepts a client and an adverse party, by name or by number', () => {
  assert.deepEqual(parseParties([{ role: 'CLIENT', name: ' ישראל ישראלי ' }, { role: 'ADVERSE', companyReg: '51-234567-8' }]), [
    { role: 'CLIENT', name: 'ישראל ישראלי' }, { role: 'ADVERSE', companyReg: '512345678' },
  ]);
  assert.deepEqual(parseParties(undefined), []);
  assert.deepEqual(parseParties([]), []);
});

test('parseParties refuses anything malformed', () => {
  for (const bad of [
    'x', [{ role: 'OTHER', name: 'ישראל ישראלי' }], [{ role: 'CLIENT' }], [{ role: 'CLIENT', name: 'א' }],
    [{ role: 'CLIENT', name: 'ישראל', idNumber: '12' }], [{ role: 'CLIENT', name: 5 }], [{ role: 'ADVERSE', name: 'x'.repeat(201) }],
    Array.from({ length: MAX_PARTIES + 1 }, () => ({ role: 'CLIENT', name: 'ישראל ישראלי' })),
  ]) assert.equal(parseParties(bad), null, JSON.stringify(bad).slice(0, 60));
});

test('an adverse party who is an active client elsewhere halts: nothing stored, the firm log gets it', async () => {
  const db = new MemParties();
  await declareParties(db, KEY_A, ctx('M1'), [{ role: 'CLIENT', name: 'ישראל ישראלי' }]);
  const before = db.rows.length;
  const r = await declareParties(db, KEY_A, ctx('M2'), [{ role: 'ADVERSE', name: 'ישראל ישראלי' }]);
  assert.equal(r.halted, true);
  if (!r.halted) return;
  assert.equal(r.neutralMessage, NEUTRAL_REJECTION_MESSAGE);
  assert.equal(db.rows.length, before);
  assert.equal(db.checks.at(-1)?.status, 'DIRECT_CONFLICT');
  assert.equal(db.checks.at(-1)?.matter_id, 'M2');
  assert.equal(db.audits.at(-1)?.action, 'CONFLICT_HALT');
  assert.equal(db.status.get('M2'), undefined);
});

test('a clean declaration stores blind indexes only and writes the check and the audit line', async () => {
  const db = new MemParties();
  const r = await declareParties(db, KEY_A, ctx('M1'), [{ role: 'CLIENT', name: 'ישראל ישראלי', idNumber: '000000018' }, { role: 'ADVERSE', name: 'Acme Holdings Ltd' }]);
  assert.equal(r.halted, false);
  if (r.halted) return;
  assert.equal(r.light, 'GREEN');
  assert.deepEqual(r.counts, { CLIENT: 1, ADVERSE: 1 });
  assert.equal(r.added, 2);
  const stored = JSON.stringify([db.rows, db.checks, db.audits]);
  for (const raw of ['ישראלי', '000000018', 'Acme']) assert.ok(!stored.includes(raw), `leaked ${raw}`);
  assert.deepEqual(db.audits.at(-1), { matter: 'M1', action: 'MATTER_PARTIES_DECLARED', meta: { clients: 1, adverse: 1, conflict: 'CLEAN', source: 'PARTIES' } });
  assert.equal(db.checks.at(-1)?.source, 'PARTIES');
});

test('the same matter never conflicts with itself, and a repeat is not stored twice', async () => {
  const db = new MemParties();
  await declareParties(db, KEY_A, ctx('M1'), [{ role: 'CLIENT', name: 'ישראל ישראלי' }]);
  const r = await declareParties(db, KEY_A, ctx('M1'), [{ role: 'CLIENT', name: 'ישראל ישראלי' }]);
  assert.equal(r.halted, false);
  if (r.halted) return;
  assert.equal(r.added, 0);
  assert.deepEqual(r.counts, { CLIENT: 1, ADVERSE: 0 });
});

test('a match with an archived matter is YELLOW and raises the matter to POTENTIAL', async () => {
  const db = new MemParties();
  await declareParties(db, KEY_A, ctx('M1'), [{ role: 'CLIENT', name: 'ישראל ישראלי' }]);
  for (const r of db.rows) r.matter_active = false;
  const r = await declareParties(db, KEY_A, ctx('M2'), [{ role: 'ADVERSE', name: 'ישראל ישראלי' }]);
  assert.equal(r.halted, false);
  if (r.halted) return;
  assert.equal(r.light, 'YELLOW');
  assert.equal(db.status.get('M2'), 'POTENTIAL');
  assert.deepEqual(db.checks.at(-1)?.reason_codes, ['OPPOSING_HISTORICAL_MATTER']);
});

test('if the audit line cannot be written, the parties just stored are taken back', async () => {
  const db = new MemParties();
  db.failAudit = true;
  await assert.rejects(declareParties(db, KEY_A, ctx('M1'), [{ role: 'CLIENT', name: 'ישראל ישראלי' }]));
  assert.equal(db.rows.length, 0);
});
