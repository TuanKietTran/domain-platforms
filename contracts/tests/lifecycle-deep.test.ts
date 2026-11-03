import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import type { ContractId } from '../src/core/ids.ts';
import { canTransition, TERMINAL_STATES, type Contract } from '../src/lifecycle/index.ts';
import { makeWorld, SAMPLE_CONTENT, type World } from './helpers.ts';

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

function toSigned(w: World): Contract {
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  w.contracts.transition(w.counselCtx, c.id, 'sent_for_signature');
  return w.contracts.transition(w.adminCtx, c.id, 'signed');
}
function toActive(w: World, opts: { effectiveAt?: string; expiresAt?: string } = {}): Contract {
  const s = toSigned(w);
  return w.contracts.transition(w.counselCtx, s.id, 'active', opts);
}

test('amendment of a signed parent succeeds, links to parent, and does not mutate the parent', () => {
  const w = makeWorld();
  const parent = toSigned(w);
  const amd = w.contracts.create(w.counselCtx, { kind: 'amendment', counterparty: 'Globex', content: SAMPLE_CONTENT, amendmentOf: parent.id });
  assert.equal(amd.state, 'draft');
  assert.equal(amd.amendmentOf, parent.id);
  assert.equal(amd.kind, 'amendment');
  assert.equal(w.versions.current(amd.id).number, 1);
  const after = w.contracts.get(w.counselCtx, parent.id);
  assert.equal(after.state, 'signed');
  assert.equal(after.currentVersionId, parent.currentVersionId);
  assert.deepEqual(w.contracts.list(w.counselCtx, { kind: 'amendment' }).map((c) => c.id), [amd.id]);
});

test('amendment of an active parent succeeds; amendment of a terminated parent is rejected', () => {
  const w = makeWorld();
  const parent = toActive(w);
  const amd = w.contracts.create(w.counselCtx, { kind: 'amendment', counterparty: 'Globex', content: SAMPLE_CONTENT, amendmentOf: parent.id });
  assert.equal(amd.amendmentOf, parent.id);
  w.contracts.transition(w.counselCtx, parent.id, 'terminated');
  assert.throws(() => w.contracts.create(w.counselCtx, { kind: 'amendment', counterparty: 'Globex', content: SAMPLE_CONTENT, amendmentOf: parent.id }), isCode('VALIDATION'));
});

test('termination is reachable from signed, active and suspended, and is terminal', () => {
  const w = makeWorld();
  const fromSigned = toSigned(w);
  assert.equal(w.contracts.transition(w.counselCtx, fromSigned.id, 'terminated').state, 'terminated');
  const fromActive = toActive(w);
  assert.equal(w.contracts.transition(w.counselCtx, fromActive.id, 'terminated').state, 'terminated');
  const fromSuspended = toActive(w);
  w.contracts.transition(w.counselCtx, fromSuspended.id, 'suspended');
  const term = w.contracts.transition(w.counselCtx, fromSuspended.id, 'terminated');
  assert.equal(term.state, 'terminated');
  assert.ok(TERMINAL_STATES.includes('terminated'));
  assert.throws(() => w.contracts.transition(w.counselCtx, term.id, 'active'), (e: unknown) => e instanceof DomainError && e.code === 'INVALID_TRANSITION' && Array.isArray(e.details.allowed) && (e.details.allowed as string[]).length === 0);
});

test('termination is not reachable directly from draft, in_review or approved', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  assert.throws(() => w.contracts.transition(w.counselCtx, c.id, 'terminated'), isCode('INVALID_TRANSITION'));
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  assert.throws(() => w.contracts.transition(w.counselCtx, c.id, 'terminated'), isCode('INVALID_TRANSITION'));
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  assert.throws(() => w.contracts.transition(w.counselCtx, c.id, 'terminated'), isCode('INVALID_TRANSITION'));
  assert.equal(w.contracts.get(w.counselCtx, c.id).state, 'approved');
});

test('suspend retains effective/expires dates; resume reactivates the contract', () => {
  const w = makeWorld();
  const active = toActive(w, { effectiveAt: '2026-02-01T00:00:00.000Z', expiresAt: '2027-02-01T00:00:00.000Z' });
  assert.equal(active.effectiveAt, '2026-02-01T00:00:00.000Z');
  assert.equal(active.expiresAt, '2027-02-01T00:00:00.000Z');
  const suspended = w.contracts.transition(w.counselCtx, active.id, 'suspended');
  assert.equal(suspended.effectiveAt, '2026-02-01T00:00:00.000Z');
  assert.equal(suspended.expiresAt, '2027-02-01T00:00:00.000Z');
  assert.throws(() => w.contracts.transition(w.counselCtx, active.id, 'expired'), isCode('INVALID_TRANSITION'));
  const resumed = w.contracts.transition(w.counselCtx, active.id, 'active', { effectiveAt: '2026-02-01T00:00:00.000Z' });
  assert.equal(resumed.state, 'active');
  assert.equal(resumed.effectiveAt, '2026-02-01T00:00:00.000Z');
  assert.equal(resumed.expiresAt, '2027-02-01T00:00:00.000Z');
});

test('activation defaults effectiveAt to now and takes expiresAt from opts (the renewal term)', () => {
  const w = makeWorld();
  const active = toActive(w, { expiresAt: '2027-01-05T09:00:00.000Z' });
  assert.equal(active.effectiveAt, '2026-01-05T09:00:00.000Z');
  assert.equal(active.expiresAt, '2027-01-05T09:00:00.000Z');
});

test('a later transition can extend expiresAt; an expired contract cannot be renewed or reactivated', () => {
  const w = makeWorld();
  const active = toActive(w, { expiresAt: '2027-01-05T09:00:00.000Z' });
  const extended = w.contracts.transition(w.counselCtx, active.id, 'suspended', { expiresAt: '2028-01-05T09:00:00.000Z' });
  assert.equal(extended.expiresAt, '2028-01-05T09:00:00.000Z');
  w.contracts.transition(w.counselCtx, active.id, 'active');
  const expired = w.contracts.transition(w.counselCtx, active.id, 'expired');
  assert.equal(expired.state, 'expired');
  assert.ok(TERMINAL_STATES.includes('expired'));
  assert.equal(canTransition('expired', 'active'), false);
  assert.throws(() => w.contracts.transition(w.counselCtx, active.id, 'active'), isCode('INVALID_TRANSITION'));
});

test('expire is only reachable from active, not from signed', () => {
  const w = makeWorld();
  const s = toSigned(w);
  assert.throws(() => w.contracts.transition(w.counselCtx, s.id, 'expired'), isCode('INVALID_TRANSITION'));
});

test('rejection is reachable from draft and in_review, is terminal, and blocks amendments', () => {
  const w = makeWorld();
  const a = w.contracts.create(w.counselCtx, { kind: 'nda', counterparty: 'Initech', content: SAMPLE_CONTENT });
  assert.equal(w.contracts.transition(w.counselCtx, a.id, 'rejected').state, 'rejected');
  const b = w.contracts.create(w.counselCtx, { kind: 'nda', counterparty: 'Initech', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, b.id, 'in_review');
  assert.equal(w.contracts.transition(w.counselCtx, b.id, 'rejected').state, 'rejected');
  assert.throws(() => w.contracts.transition(w.counselCtx, b.id, 'draft'), isCode('INVALID_TRANSITION'));
  assert.throws(() => w.contracts.create(w.counselCtx, { kind: 'amendment', counterparty: 'Initech', content: SAMPLE_CONTENT, amendmentOf: b.id }), isCode('VALIDATION'));
});

test('review bounce-back: in_review -> draft, approved -> draft, sent_for_signature -> draft', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  assert.equal(w.contracts.transition(w.counselCtx, c.id, 'draft').state, 'draft');
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  assert.equal(w.contracts.transition(w.counselCtx, c.id, 'draft').state, 'draft');
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  w.contracts.transition(w.counselCtx, c.id, 'sent_for_signature');
  assert.equal(w.contracts.transition(w.counselCtx, c.id, 'draft').state, 'draft');
});

test('signing requires contract:sign; counsel cannot sign, admin can', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  w.contracts.transition(w.counselCtx, c.id, 'sent_for_signature');
  assert.throws(() => w.contracts.transition(w.counselCtx, c.id, 'signed'), isCode('FORBIDDEN'));
  assert.equal(w.contracts.transition(w.adminCtx, c.id, 'signed').state, 'signed');
});

test('create validation, read permissions, tenant scoping, list filters and NOT_FOUND', () => {
  const w = makeWorld();
  assert.throws(() => w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: '   ', content: SAMPLE_CONTENT }), isCode('VALIDATION'));
  assert.throws(() => w.contracts.create(w.viewerCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT }), isCode('FORBIDDEN'));
  const a = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.create(w.counselCtx, { kind: 'nda', counterparty: 'Initech', content: SAMPLE_CONTENT });
  assert.throws(() => w.contracts.get(w.outsiderCtx, a.id), isCode('TENANT_MISMATCH'));
  assert.throws(() => w.contracts.get(w.counselCtx, 'ctr_missing' as ContractId), isCode('NOT_FOUND'));
  assert.deepEqual(w.contracts.list(w.counselCtx, { state: 'draft' }).length, 2);
  assert.deepEqual(w.contracts.list(w.counselCtx, { kind: 'nda' }).map((c) => c.counterparty), ['Initech']);
  assert.deepEqual(w.contracts.list(w.outsiderCtx), []);
  w.contracts.transition(w.counselCtx, a.id, 'in_review');
  assert.deepEqual(w.contracts.list(w.counselCtx, { state: 'draft' }).length, 1);
  assert.deepEqual(w.contracts.list(w.counselCtx, { state: 'in_review' }).map((c) => c.id), [a.id]);
});

test('addVersion succeeds in draft and in_review and advances the current version', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const v1 = c.currentVersionId;
  const inDraft = w.contracts.addVersion(w.counselCtx, c.id, { ...SAMPLE_CONTENT, title: 'MSA v2' }, 'draft edit');
  assert.notEqual(inDraft.currentVersionId, v1);
  assert.equal(w.versions.current(c.id).number, 2);
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  const inReview = w.contracts.addVersion(w.counselCtx, c.id, { ...SAMPLE_CONTENT, title: 'MSA v3' }, 'review edit');
  assert.notEqual(inReview.currentVersionId, inDraft.currentVersionId);
  assert.equal(w.versions.current(c.id).number, 3);
});

test('every lifecycle transition is audited in order', () => {
  const w = makeWorld();
  const active = toActive(w);
  w.contracts.transition(w.counselCtx, active.id, 'suspended');
  w.contracts.transition(w.counselCtx, active.id, 'terminated');
  const actions = w.audit.list(w.tenant.id, { subjectId: active.id }).map((e) => e.action);
  assert.deepEqual(actions, ['contract.created', 'contract.transitioned', 'contract.transitioned', 'contract.transitioned', 'contract.transitioned', 'contract.transitioned', 'contract.transitioned', 'contract.transitioned']);
  assert.equal(w.audit.verify(), true);
});
