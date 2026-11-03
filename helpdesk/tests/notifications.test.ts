import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/core/clock.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId, SequentialIdGenerator } from '../src/core/ids.js';
import { InMemorySender, NotificationEngine } from '../src/notifications/engine.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

function newEngine(): { engine: NotificationEngine; email: InMemorySender } {
  const engine = new NotificationEngine(new SequentialIdGenerator(), new FakeClock('2026-01-05T09:00:00.000Z'));
  const email = new InMemorySender('email');
  engine.registerSender(email);
  engine.registerTemplate({ id: 'ticket-created', category: 'ticket', subject: 'Ticket {{number}} created', body: 'Hi {{name}}, your ticket {{number}} is open.' });
  return { engine, email };
}

test('send renders template variables and delivers through the channel sender', () => {
  const { engine, email } = newEngine();
  const record = engine.send({ tenantId: tenantA, recipientId: 'cus-1', templateId: 'ticket-created', channel: 'email', variables: { number: '42', name: 'Sam' } });
  assert.equal(record.status, 'sent');
  assert.equal(record.subject, 'Ticket 42 created');
  assert.equal(record.body, 'Hi Sam, your ticket 42 is open.');
  assert.equal(record.createdAt, '2026-01-05T09:00:00.000Z');
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0]?.body, record.body);
  assert.equal(engine.list(tenantA, 'cus-1').length, 1);
  assert.equal(engine.list(tenantB).length, 0);
});

test('send validates templates, variables and senders', () => {
  const { engine } = newEngine();
  throwsCode(() => engine.send({ tenantId: tenantA, recipientId: 'c', templateId: 'missing', channel: 'email' }), 'NOT_FOUND');
  throwsCode(() => engine.send({ tenantId: tenantA, recipientId: 'c', templateId: 'ticket-created', channel: 'email', variables: { number: '1' } }), 'VALIDATION');
  throwsCode(() => engine.send({ tenantId: tenantA, recipientId: 'c', templateId: 'ticket-created', channel: 'sms', variables: { number: '1', name: 'S' } }), 'NOT_FOUND');
  throwsCode(() => engine.registerTemplate({ id: 'ticket-created', category: 'x', body: 'y' }), 'CONFLICT');
});

test('an opted-out recipient is suppressed and the sender is never called', () => {
  const { engine, email } = newEngine();
  engine.setChannelOptOut(tenantA, 'cus-2', 'email');
  const record = engine.send({ tenantId: tenantA, recipientId: 'cus-2', templateId: 'ticket-created', channel: 'email', variables: { number: '7', name: 'Kim' } });
  assert.equal(record.status, 'suppressed');
  assert.equal(record.reason, 'opt_out');
  assert.equal(email.sent.length, 0);
  engine.setChannelOptOut(tenantA, 'cus-2', 'email', false);
  const second = engine.send({ tenantId: tenantA, recipientId: 'cus-2', templateId: 'ticket-created', channel: 'email', variables: { number: '8', name: 'Kim' } });
  assert.equal(second.status, 'sent');
  assert.equal(email.sent.length, 1);
});

test('a dedupe key returns the first record and delivers only once', () => {
  const { engine, email } = newEngine();
  const input = { tenantId: tenantA, recipientId: 'cus-3', templateId: 'ticket-created', channel: 'email' as const, variables: { number: '9', name: 'Ana' }, dedupeKey: 'ticket-9-created' };
  const first = engine.send(input);
  const again = engine.send(input);
  assert.equal(again.id, first.id);
  assert.equal(email.sent.length, 1);
  const different = engine.send({ ...input, dedupeKey: 'ticket-9-updated' });
  assert.notEqual(different.id, first.id);
  assert.equal(email.sent.length, 2);
});
