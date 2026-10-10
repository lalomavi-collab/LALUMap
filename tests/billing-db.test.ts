// Runs supabase/tests/billing_trust.sql (portal isolation, trust ledger, billing lifecycle) against a real Postgres.
// Set LALUM_TEST_DB_URL to a database that has all migrations applied (a throwaway one: the script rolls back).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const url = process.env.LALUM_TEST_DB_URL;
for (const [file, min] of [['billing_trust.sql', 16], ['billing_rpcs.sql', 7]] as const) {
  test(`SQL suite ${file}`, { skip: url ? false : 'LALUM_TEST_DB_URL not set' }, () => {
    const r = spawnSync('psql', [url!, '-v', 'ON_ERROR_STOP=1', '-f', `supabase/tests/${file}`], { encoding: 'utf8' });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, out);
    const passes = out.match(/PASS:/g)?.length ?? 0;
    assert.ok(passes >= min, `expected at least ${min} PASS lines, got ${passes}\n${out}`);
    assert.doesNotMatch(out, /FAIL/);
  });
}
