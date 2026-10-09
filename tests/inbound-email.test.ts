import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressOf, aliasFrom, bodyText, isAutomated } from '../lib/services/inboundEmail.ts';

test('alias is found in any recipient form, others ignored', () => {
  assert.equal(aliasFrom(['x@y.co', 'Inbox <INQ-0123456789@lalumapp.com>']), '0123456789');
  assert.equal(aliasFrom(['inq-0123456789@lalumapp.com.evil.co', 'inq-xyz@lalumapp.com', 'contact@lalumapp.com']), null);
  assert.equal(aliasFrom([]), null);
});
test('sender address parsing', () => {
  assert.equal(addressOf('Test Person <Test.Person@Example.test>'), 'test.person@example.test');
  assert.equal(addressOf('plain@example.test'), 'plain@example.test');
  assert.equal(addressOf('no address here'), null);
});
test('automated mail is filtered', () => {
  assert.equal(isAutomated('mailer-daemon@x.co', {}), true);
  assert.equal(isAutomated('noreply@x.co', {}), true);
  assert.equal(isAutomated('a@x.co', { 'Auto-Submitted': 'auto-replied' }), true);
  assert.equal(isAutomated('a@x.co', [{ name: 'Precedence', value: 'bulk' }]), true);
  assert.equal(isAutomated('a@x.co', { 'Auto-Submitted': 'no' }), false);
  assert.equal(isAutomated('client@example.test', undefined), false);
});
test('body text from html, capped', () => {
  assert.equal(bodyText('', '<p>שלום&nbsp;עולם</p><style>p{}</style><div>שורה</div>'), 'שלום עולם\nשורה');
  assert.equal(bodyText('abc', '<p>ignored</p>'), 'abc');
  assert.equal(bodyText('x'.repeat(30000), null).length, 20000);
});
