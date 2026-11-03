import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiAdapter, ChatAdapter, createDefaultChannelRegistry, EmailAdapter, PhoneAdapter, toCreateTicketInput, WebAdapter } from '../src/channels/adapters.js';
import { FakeClock } from '../src/core/clock.js';
import { DomainError } from '../src/core/errors.js';
import { asCustomerId, asTenantId } from '../src/core/ids.js';

const tenantA = asTenantId('tenant-a');
const clock = new FakeClock('2026-01-05T09:00:00.000Z');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

test('email adapter normalizes sender, subject and body, and strips HTML as a fallback', () => {
  const adapter = new EmailAdapter(clock);
  const intake = adapter.adapt({ messageId: 'm-1', from: { email: 'User@Example.com', name: 'User' }, subject: ' Help ', text: ' My app crashed ', date: '2026-01-04T10:00:00.000Z' }, tenantA);
  assert.equal(intake.channel, 'email');
  assert.equal(intake.subject, 'Help');
  assert.equal(intake.description, 'My app crashed');
  assert.equal(intake.requester.email, 'user@example.com');
  assert.equal(intake.externalId, 'm-1');
  assert.equal(intake.receivedAt, '2026-01-04T10:00:00.000Z');
  const htmlOnly = adapter.adapt({ messageId: 'm-2', from: { email: 'a@b.co' }, html: '<p>Hello <b>world</b></p>' }, tenantA);
  assert.equal(htmlOnly.description, 'Hello world');
  assert.equal(htmlOnly.subject, '(no subject)');
  throwsCode(() => adapter.adapt({ messageId: 'm-3', from: { email: 'not-an-email' }, text: 'x' }, tenantA), 'VALIDATION');
  throwsCode(() => adapter.adapt({ messageId: 'm-4', from: { email: 'a@b.co' } }, tenantA), 'VALIDATION');
});

test('chat adapter joins messages and derives the subject from the first message', () => {
  const adapter = new ChatAdapter(clock);
  const intake = adapter.adapt({ sessionId: 's-1', userId: 'u-9', messages: [{ text: 'Hi, my order is late' }, { text: 'Order 42' }] }, tenantA);
  assert.equal(intake.subject, 'Hi, my order is late');
  assert.equal(intake.description, 'Hi, my order is late\nOrder 42');
  assert.equal(intake.requester.externalId, 'u-9');
  assert.equal(intake.receivedAt, '2026-01-05T09:00:00.000Z');
  throwsCode(() => adapter.adapt({ sessionId: 's-2', userId: 'u-9', messages: [] }, tenantA), 'VALIDATION');
});

test('web adapter maps a form submission, with category tag and language', () => {
  const adapter = new WebAdapter(clock);
  const intake = adapter.adapt({ submissionId: 'w-1', email: 'a@b.co', message: 'Cannot download my invoice', category: 'Billing', language: 'en' }, tenantA);
  assert.equal(intake.subject, 'Billing request');
  assert.deepEqual(intake.tags, ['web', 'billing']);
  assert.equal(intake.language, 'en');
});

test('api adapter passes priority and tags through and validates priority', () => {
  const adapter = new ApiAdapter(clock);
  const intake = adapter.adapt({ externalId: 'ext-1', customerId: 'cus-1', title: 'API outage', body: '500s everywhere', priority: 'urgent', tags: ['api'] }, tenantA);
  assert.equal(intake.priority, 'urgent');
  assert.deepEqual(intake.tags, ['api']);
  throwsCode(() => adapter.adapt({ externalId: 'e', customerId: 'c', title: 't', body: 'b', priority: 'whenever' }, tenantA), 'VALIDATION');
});

test('phone adapter builds a subject from the caller and uses the transcript as the body', () => {
  const adapter = new PhoneAdapter(clock);
  const intake = adapter.adapt({ callId: 'call-1', phone: '+84901234567', callerName: 'Kyle', transcript: 'Customer asked about a refund.' }, tenantA);
  assert.equal(intake.subject, 'Phone call from Kyle (+84901234567)');
  assert.equal(intake.description, 'Customer asked about a refund.');
  assert.equal(intake.requester.phone, '+84901234567');
  throwsCode(() => adapter.adapt({ callId: 'c', phone: '+1', transcript: ' ' }, tenantA), 'VALIDATION');
});

test('registry routes by channel, rejects duplicates and unknown channels, and intakes map to ticket inputs', () => {
  const registry = createDefaultChannelRegistry(clock);
  assert.deepEqual(registry.channels(), ['email', 'chat', 'web', 'api', 'phone']);
  const intake = registry.adapt('web', { submissionId: 'w-9', email: 'a@b.co', message: 'help me' }, tenantA);
  const input = toCreateTicketInput(intake, asCustomerId('cus_000001'));
  assert.equal(input.channel, 'web');
  assert.equal(input.subject, 'Web form submission');
  assert.equal(input.idempotencyKey, 'web:w-9');
  throwsCode(() => registry.register(new EmailAdapter(clock) as never), 'CONFLICT');
  throwsCode(() => registry.get('fax' as never), 'NOT_FOUND');
});
