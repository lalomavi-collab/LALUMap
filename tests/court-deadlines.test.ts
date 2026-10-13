import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDeadline, explain, recessOf } from '../lib/services/courtDeadlines.ts';

test('recess boundaries: summer 21 July to 5 September inclusive', () => {
  assert.equal(recessOf('2026-07-20'), null);
  assert.equal(recessOf('2026-07-21'), 'פגרת הקיץ');
  assert.equal(recessOf('2026-09-05'), 'פגרת הקיץ');
  assert.equal(recessOf('2026-09-06'), null);
});

test('Sukkot and Pesach recess follow the Hebrew calendar (2026)', () => {
  assert.equal(recessOf('2026-09-24'), null);              // 13 Tishrei
  assert.equal(recessOf('2026-09-25'), 'פגרת סוכות');      // 14 Tishrei
  assert.equal(recessOf('2026-10-03'), 'פגרת סוכות');      // 22 Tishrei
  assert.equal(recessOf('2026-10-04'), null);
  assert.equal(recessOf('2026-04-01'), 'פגרת הפסח');       // 14 Nisan 5786
  assert.equal(recessOf('2026-04-08'), 'פגרת הפסח');       // 21 Nisan
  assert.equal(recessOf('2026-04-09'), null);
});

test('service 10 July 2026, 30 days: summer freeze, then Sukkot freeze, lands 4 October', () => {
  const r = computeDeadline('2026-07-10', 30);
  assert.equal(r.segments[0]!.kind, 'COUNTED');
  assert.deepEqual([r.segments[0]!.from, r.segments[0]!.to, r.segments[0]!.days], ['2026-07-11', '2026-07-20', 10]);
  assert.deepEqual([r.segments[1]!.kind, r.segments[1]!.from, r.segments[1]!.to, r.segments[1]!.days], ['RECESS', '2026-07-21', '2026-09-05', 47]);
  assert.deepEqual([r.segments[2]!.from, r.segments[2]!.to, r.segments[2]!.days], ['2026-09-06', '2026-09-24', 19]);
  assert.equal(r.segments[3]!.label, 'פגרת סוכות');
  assert.equal(r.finalDate, '2026-10-04');
  assert.equal(r.recessDaysFrozen, 47 + 9);
  assert.match(explain(r), /מועד אחרון: 2026-10-04/);
});

test('same service date in 2025: lands late September (Thursday 25 Sept), no Sukkot overlap', () => {
  const r = computeDeadline('2025-07-10', 30);
  assert.equal(r.finalDate, '2025-09-25');
  assert.equal(r.rolled.length, 0);
});

test('last day on Friday rolls to Sunday (reg. 4 of the Recesses Regulations)', () => {
  const r = computeDeadline('2026-01-01', 30);   // counted end 31 Jan 2026 is a Saturday
  assert.equal(r.countedEnd, '2026-01-31');
  assert.equal(r.finalDate, '2026-02-01');
  const f = computeDeadline('2026-01-02', 30);   // counted end 1 Feb is Sunday, no roll
  assert.equal(f.finalDate, '2026-02-01');
  const fri = computeDeadline('2026-02-06', 7);  // 13 Feb 2026 is a Friday
  assert.equal(fri.countedEnd, '2026-02-13');
  assert.equal(fri.finalDate, '2026-02-15');
});

test('Rosh Hashana as last day rolls forward (2026: 12-13 Sept, last day 13 Sept)', () => {
  const r = computeDeadline('2026-08-30', 8);    // counting restarts 6 Sept, day 8 = 13 Sept (2 Tishrei)
  assert.equal(r.countedEnd, '2026-09-13');
  assert.equal(r.rolled[0]!.reason, 'ראש השנה');
  assert.equal(r.finalDate, '2026-09-14');
});

test('input validation', () => {
  assert.throws(() => computeDeadline('2026-13-40', 5));
  assert.throws(() => computeDeadline('2026-07-10', 0));
});
