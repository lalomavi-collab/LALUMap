// Loads the repo migrations plus a replica of the live billing/trust/portal objects into a THROWAWAY database and runs
// supabase/tests/live_model/security.sql. Set LALUM_PG_ADMIN_URL to an admin connection of a disposable Postgres 15+
// server (e.g. postgresql://postgres@localhost:5433/postgres?host=/var/tmp/lalum-pg). Skipped when unset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const admin = process.env.LALUM_PG_ADMIN_URL;
const psql = (url: string, args: string[]) => spawnSync('psql', [url, '-q', ...args], { encoding: 'utf8' });
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

test('live-model security suite (portal isolation, trust ledger, billing locks)', { skip: admin ? false : 'LALUM_PG_ADMIN_URL not set' }, () => {
  const db = `lalum_t_${process.pid}`;
  const url = withDb(admin!, db);
  assert.equal(psql(admin!, ['-c', `create database ${db}`]).status, 0);
  try {
    assert.equal(psql(url, ['-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/live_model/stub-supabase.sql']).status, 0);
    for (const f of readdirSync('supabase/migrations').sort()) {
      const r = psql(url, ['-f', `supabase/migrations/${f}`]);
      const bad = (r.stderr ?? '').split('\n').filter((l) => /ERROR/.test(l) && !/cron|storage/.test(l));
      assert.deepEqual(bad, [], `${f}: ${bad.join('\n')}`);
    }
    const rep = psql(url, ['-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/live_model/replica.sql']);
    assert.equal(rep.status, 0, rep.stderr);
    const r = psql(url, ['-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/live_model/security.sql']);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, out);
    const passes = out.match(/PASS:/g)?.length ?? 0;
    assert.ok(passes >= 20, `expected at least 20 PASS lines, got ${passes}\n${out}`);
    assert.doesNotMatch(out, /FAIL/);
  } finally {
    psql(admin!, ['-c', `drop database if exists ${db}`]);
  }
});
