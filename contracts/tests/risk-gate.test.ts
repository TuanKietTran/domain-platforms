import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { applyDeviations, assessRisk, assessWithDeviations, requiredApprovers } from '../src/risk/index.ts';
import { contextFor, type AccessContext } from '../src/identity/index.ts';
import { ContractService } from '../src/lifecycle/index.ts';
import { makeWorld, SAMPLE_CONTENT, type World } from './helpers.ts';

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

const RISKY = { title: 'Risky', clauses: [
  { id: 'r1', heading: 'Liability', body: 'Supplier accepts unlimited liability for all claims.' },
  { id: 'r2', heading: 'Renewal', body: 'This agreement will auto-renew for successive terms.' },
  { id: 'r3', heading: 'Termination', body: 'Customer may terminate for convenience at any time.' },
] };

const makeApproverCtx = (w: World): AccessContext =>
  contextFor(w.directory.createUser(w.tenant.id, 'appr@acme.test', 'Approver', ['approver']));

test('deviations add explainable points and can escalate the band', () => {
  const base = assessRisk(SAMPLE_CONTENT);
  assert.equal(base.band, 'low');
  const withMajor = applyDeviations(base, [{ clauseKey: 'payment', severity: 'major', detail: 'matches unacceptable wording' }]);
  assert.equal(withMajor.score, base.score + 20);
  assert.ok(withMajor.signals.some((s) => s.rule === 'playbook_deviation_major' && s.evidence.includes('payment')));
  const withMinor = applyDeviations(base, [{ clauseKey: 'payment', severity: 'minor', detail: 'matches fallback position only' }]);
  assert.equal(withMinor.score, base.score + 5);
  const withNone = applyDeviations(base, [{ clauseKey: 'payment', severity: 'none', detail: 'matches preferred position' }]);
  assert.equal(withNone.score, base.score);
  const twoMajor = assessWithDeviations(SAMPLE_CONTENT, [
    { clauseKey: 'a', severity: 'major', detail: 'x' }, { clauseKey: 'b', severity: 'major', detail: 'y' },
  ]);
  assert.equal(twoMajor.score, 40);
  assert.equal(twoMajor.band, 'high');
  assert.deepEqual(requiredApprovers(twoMajor), ['approver', 'counsel']);
});

test('gate: clean contract needs a completed approver approval before -> approved', () => {
  const w = makeWorld();
  const approverCtx = makeApproverCtx(w);
  const c = w.gatedContracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.gatedContracts.transition(w.counselCtx, c.id, 'in_review');
  assert.throws(() => w.gatedContracts.transition(w.counselCtx, c.id, 'approved'), isCode('APPROVAL_REQUIRED'));
  const req = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: requiredApprovers(assessRisk(SAMPLE_CONTENT)) });
  // a pending request does not open the gate
  assert.throws(() => w.gatedContracts.transition(w.counselCtx, c.id, 'approved'), isCode('APPROVAL_REQUIRED'));
  w.approvals.decide(approverCtx, req.id, 'approved');
  assert.equal(w.gatedContracts.transition(w.counselCtx, c.id, 'approved').state, 'approved');
});

test('gate: critical content needs the full matrix; a partial approval does not open it', () => {
  const w = makeWorld();
  const approverCtx = makeApproverCtx(w);
  const c = w.gatedContracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: RISKY });
  w.gatedContracts.transition(w.counselCtx, c.id, 'in_review');
  const required = requiredApprovers(assessRisk(RISKY));
  assert.deepEqual(required, ['approver', 'counsel', 'admin']); // RISKY scores 65 = critical
  const partial = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: ['approver'] });
  w.approvals.decide(approverCtx, partial.id, 'approved');
  assert.throws(() => w.gatedContracts.transition(w.counselCtx, c.id, 'approved'), isCode('APPROVAL_REQUIRED'));
  const full = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: required });
  w.approvals.decide(approverCtx, full.id, 'approved');
  w.approvals.decide(w.counselCtx, full.id, 'approved');
  // admin still missing: request pending, gate still closed
  assert.throws(() => w.gatedContracts.transition(w.counselCtx, c.id, 'approved'), isCode('APPROVAL_REQUIRED'));
  w.approvals.decide(w.adminCtx, full.id, 'approved');
  assert.equal(w.gatedContracts.transition(w.counselCtx, c.id, 'approved').state, 'approved');
});

test('gate: a rejected approval does not open it, and non-approver roles cannot decide', () => {
  const w = makeWorld();
  const approverCtx = makeApproverCtx(w);
  const c = w.gatedContracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.gatedContracts.transition(w.counselCtx, c.id, 'in_review');
  const req = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: ['approver'] });
  // contributor can write/request but holds no contract:approve permission
  assert.throws(() => w.approvals.decide(w.contributorCtx, req.id, 'approved'), isCode('FORBIDDEN'));
  w.approvals.decide(approverCtx, req.id, 'rejected');
  assert.throws(() => w.gatedContracts.transition(w.counselCtx, c.id, 'approved'), isCode('APPROVAL_REQUIRED'));
});

test('gate: playbook deviations escalate the matrix inside the lifecycle', () => {
  const w = makeWorld();
  const approverCtx = makeApproverCtx(w);
  w.playbooks.upsertPlaybook(w.counselCtx, { key: 'standard', title: 'Standard', positions: [
    { clauseKey: 'payment', preferred: 'payment within 30 days', fallback: 'payment within 45 days', unacceptable: 'payment within 90 days', note: '' },
    { clauseKey: 'term', preferred: 'term of 12 months', fallback: 'term of 24 months', unacceptable: '', note: '' },
  ] });
  const gated = new ContractService({ clock: w.clock, audit: w.audit, versions: w.versions, approvals: w.approvals, playbooks: w.playbooks, playbookKey: 'standard' });
  const content = { title: 'Services', clauses: [
    { id: 'payment', heading: 'Payment', body: 'Payment within 90 days.' },
    { id: 'confidentiality', heading: 'Confidentiality', body: 'All confidential information stays secret.' },
  ] };
  assert.equal(assessRisk(content).band, 'low'); // no content pattern fires
  const c = gated.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content });
  gated.transition(w.counselCtx, c.id, 'in_review');
  // deviations: payment major (unacceptable) + term major (missing) = +40 -> high -> counsel required
  const req = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: ['approver'] });
  w.approvals.decide(approverCtx, req.id, 'approved');
  assert.throws(() => gated.transition(w.counselCtx, c.id, 'approved'), isCode('APPROVAL_REQUIRED'));
  const req2 = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: ['approver', 'counsel'] });
  w.approvals.decide(approverCtx, req2.id, 'approved');
  w.approvals.decide(w.counselCtx, req2.id, 'approved');
  assert.equal(gated.transition(w.counselCtx, c.id, 'approved').state, 'approved');
});

test('decide: a multi-role decider fills an unsatisfied role, not a duplicate', () => {
  const w = makeWorld();
  const approverCtx = makeApproverCtx(w);
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const req = w.approvals.request(w.counselCtx, { contractId: c.id, requiredRoles: ['approver', 'counsel'] });
  w.approvals.decide(approverCtx, req.id, 'approved'); // approver slot filled
  const multi = w.directory.createUser(w.tenant.id, 'multi@acme.test', 'Multi', ['approver', 'counsel']);
  const done = w.approvals.decide(contextFor(multi), req.id, 'approved');
  assert.equal(done.decisions[1]?.role, 'counsel');
  assert.equal(done.status, 'approved');
});
