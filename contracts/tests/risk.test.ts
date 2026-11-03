import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { assessRisk, requiredApprovers } from '../src/risk/index.ts';
import { contextFor } from '../src/identity/index.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

const RISKY = { title: 'Risky', clauses: [
  { id: 'r1', heading: 'Liability', body: 'Supplier accepts unlimited liability for all claims.' },
  { id: 'r2', heading: 'Renewal', body: 'This agreement will auto-renew for successive terms.' },
  { id: 'r3', heading: 'Termination', body: 'Customer may terminate for convenience at any time.' },
] };

test('risk scoring is explainable: every point names its rule', () => {
  const a = assessRisk(RISKY);
  assert.ok(a.score >= 55);
  assert.ok(a.signals.some((s) => s.rule === 'unlimited_liability'));
  assert.ok(a.signals.some((s) => s.rule === 'confidentiality_absent')); // RISKY has no confidentiality clause
  assert.equal(a.score, Math.min(100, a.signals.reduce((s, x) => s + x.points, 0)));
});

test('clean content scores low; approval matrix escalates with band and value', () => {
  const clean = assessRisk(SAMPLE_CONTENT);
  assert.equal(clean.band, 'low');
  assert.deepEqual(requiredApprovers(clean), ['approver']);
  const risky = assessRisk(RISKY, { valueMinor: 200_000_00 });
  assert.ok(requiredApprovers(risky).includes('counsel'));
});

test('approval flow: all required roles must approve; any rejection closes it', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const req = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: ['approver', 'counsel'] });
  // viewer holds neither required role and lacks contract:approve
  assert.throws(() => w.approvals.decide(w.viewerCtx, req.id, 'approved'),
    (e: unknown) => e instanceof DomainError && e.code === 'FORBIDDEN');
  // roles come from ctx now: admin wildcard fills the approver slot, counsel fills counsel
  const afterOne = w.approvals.decide(w.adminCtx, req.id, 'approved');
  assert.equal(afterOne.status, 'pending'); // counsel still missing
  const done = w.approvals.decide(w.counselCtx, req.id, 'approved');
  assert.equal(done.status, 'approved');
  assert.throws(() => w.approvals.decide(w.counselCtx, req.id, 'approved'),
    (e: unknown) => e instanceof DomainError && e.code === 'CONFLICT');
});

test('critical matrix: approver+counsel+admin required; counsel alone cannot satisfy it', () => {
  const a = assessRisk(RISKY, { valueMinor: 200_000_00 });
  assert.equal(a.band, 'critical'); // 65 base + 10 high_value = 75
  assert.deepEqual(requiredApprovers(a, 200_000_00), ['approver', 'counsel', 'admin']);
  const w = makeWorld();
  const approver = w.directory.createUser(w.tenant.id, 'appr@acme.test', 'Approver', ['approver']);
  const approverCtx = contextFor(approver);
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const req = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: requiredApprovers(a, 200_000_00) });
  assert.equal(w.approvals.decide(w.counselCtx, req.id, 'approved').status, 'pending'); // counsel fills only the counsel slot
  assert.throws(() => w.approvals.decide(w.counselCtx, req.id, 'approved'),
    (e: unknown) => e instanceof DomainError && e.code === 'CONFLICT'); // same user cannot decide twice
  assert.equal(w.approvals.decide(approverCtx, req.id, 'approved').status, 'pending'); // admin still missing
  assert.equal(w.approvals.decide(w.adminCtx, req.id, 'approved').status, 'approved');
});

test('risk scan includes the contract title', () => {
  const titled = { title: 'Unlimited liability addendum', clauses: [
    { id: 't1', heading: 'Confidentiality', body: 'All confidential information stays secret.' },
  ] };
  const a = assessRisk(titled);
  assert.ok(a.signals.some((s) => s.rule === 'unlimited_liability'));
  assert.equal(a.score, 30);
});

test('no zero-point signals: the dead confidentiality entry stays gone', () => {
  const a = assessRisk(RISKY);
  assert.ok(a.signals.every((s) => s.points > 0));
  const absent = a.signals.find((s) => s.rule === 'confidentiality_absent');
  assert.equal(absent?.points, 10); // the live rule, not the deleted 0-point pattern
});
