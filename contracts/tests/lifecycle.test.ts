import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { canTransition } from '../src/lifecycle/index.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

test('transition table: terminal states have no exits, draft cannot jump to signed', () => {
  assert.equal(canTransition('draft', 'in_review'), true);
  assert.equal(canTransition('draft', 'signed'), false);
  assert.equal(canTransition('terminated', 'active'), false);
  assert.equal(canTransition('active', 'suspended'), true);
});

test('happy path draft -> in_review -> approved -> sent -> signed -> active', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  assert.equal(c.state, 'draft');
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  w.contracts.transition(w.counselCtx, c.id, 'sent_for_signature');
  w.contracts.transition(w.adminCtx, c.id, 'signed'); // admin holds contract:sign
  const active = w.contracts.transition(w.counselCtx, c.id, 'active');
  assert.equal(active.state, 'active');
  assert.ok(active.effectiveAt);
});

test('illegal transition is rejected with the allowed set in details', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  assert.throws(() => w.contracts.transition(w.counselCtx, c.id, 'signed'), (e: unknown) => e instanceof DomainError && e.code === 'INVALID_TRANSITION' && e.details.from === 'draft' && e.details.to === 'signed' && Array.isArray(e.details.allowed) && (e.details.allowed as string[]).join(',') === 'in_review,rejected');
});

test('approval transition requires contract:approve; contributor cannot approve', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.contributorCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.contributorCtx, c.id, 'in_review');
  assert.throws(() => w.contracts.transition(w.contributorCtx, c.id, 'approved'), isCode('FORBIDDEN'));
  assert.equal(w.contracts.transition(w.counselCtx, c.id, 'approved').state, 'approved');
});

test('content locks after review approval; amendments require signed/active parent', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  assert.throws(() => w.contracts.addVersion(w.counselCtx, c.id, { ...SAMPLE_CONTENT, title: 'Changed' }), isCode('IMMUTABLE'));
  assert.throws(() => w.contracts.create(w.counselCtx, { kind: 'amendment', counterparty: 'Globex', content: SAMPLE_CONTENT, amendmentOf: c.id }), isCode('VALIDATION'));
});
