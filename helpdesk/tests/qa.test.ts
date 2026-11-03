import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/core/clock.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId, asTicketId, asUserId, SequentialIdGenerator } from '../src/core/ids.js';
import { QaEngine, type QaScorecard } from '../src/qa/engine.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const agent = asUserId('agent-1');
const reviewer = asUserId('reviewer-1');
const NOW = '2026-01-05T09:00:00.000Z';

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

const scorecard: QaScorecard = {
  id: 'support-v1', tenantId: tenantA, name: 'Support quality v1', passThreshold: 80,
  criteria: [
    { id: 'accuracy', name: 'Accuracy', weight: 2, maxScore: 5 },
    { id: 'empathy', name: 'Empathy', weight: 1, maxScore: 5 },
  ],
};

function newEngine(): QaEngine {
  const engine = new QaEngine(new SequentialIdGenerator(), new FakeClock(NOW));
  engine.registerScorecard(scorecard);
  return engine;
}

test('evaluate computes the weighted percentage, per-criterion results and pass/fail', () => {
  const engine = newEngine();
  const evaluation = engine.evaluate({ tenantId: tenantA, scorecardId: 'support-v1', ticketId: asTicketId('ticket-1'), agentId: agent, reviewerId: reviewer, scores: { accuracy: 5, empathy: 3 } });
  assert.equal(evaluation.percentage, 86.67);
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.createdAt, NOW);
  assert.deepEqual(evaluation.results.map((r) => [r.criterionId, r.weightedPercentage]), [['accuracy', 2], ['empathy', 0.6]]);
  const failing = engine.evaluate({ tenantId: tenantA, scorecardId: 'support-v1', ticketId: asTicketId('ticket-2'), agentId: agent, reviewerId: reviewer, scores: { accuracy: 1, empathy: 2 } });
  assert.equal(failing.percentage, 26.67);
  assert.equal(failing.passed, false);
});

test('summary aggregates count, average and pass rate per agent and tenant', () => {
  const engine = newEngine();
  engine.evaluate({ tenantId: tenantA, scorecardId: 'support-v1', ticketId: asTicketId('ticket-1'), agentId: agent, reviewerId: reviewer, scores: { accuracy: 5, empathy: 3 } });
  engine.evaluate({ tenantId: tenantA, scorecardId: 'support-v1', ticketId: asTicketId('ticket-2'), agentId: agent, reviewerId: reviewer, scores: { accuracy: 1, empathy: 2 } });
  const summary = engine.summary(tenantA, agent);
  assert.deepEqual(summary, { agentId: agent, evaluations: 2, averagePercentage: 56.67, passRate: 50 });
  assert.equal(engine.list(tenantA, agent).length, 2);
  assert.equal(engine.list(tenantB).length, 0);
  assert.deepEqual(engine.summary(tenantA, asUserId('agent-none')), { agentId: 'agent-none', evaluations: 0, averagePercentage: 0, passRate: 0 });
});

test('evaluate validates scorecard, tenant, completeness and score range', () => {
  const engine = newEngine();
  const base = { tenantId: tenantA, scorecardId: 'support-v1', ticketId: asTicketId('ticket-1'), agentId: agent, reviewerId: reviewer };
  throwsCode(() => engine.evaluate({ ...base, scores: { accuracy: 5 } }), 'VALIDATION');
  throwsCode(() => engine.evaluate({ ...base, scores: { accuracy: 5, empathy: 3, speed: 1 } }), 'VALIDATION');
  throwsCode(() => engine.evaluate({ ...base, scores: { accuracy: 6, empathy: 3 } }), 'VALIDATION');
  throwsCode(() => engine.evaluate({ ...base, tenantId: tenantB, scores: { accuracy: 5, empathy: 3 } }), 'TENANT_MISMATCH');
  throwsCode(() => engine.evaluate({ ...base, scorecardId: 'missing', scores: { accuracy: 5, empathy: 3 } }), 'NOT_FOUND');
});

test('registerScorecard validates criteria, threshold and duplicates', () => {
  const engine = newEngine();
  throwsCode(() => engine.registerScorecard(scorecard), 'CONFLICT');
  throwsCode(() => engine.registerScorecard({ ...scorecard, id: 'empty', criteria: [] }), 'VALIDATION');
  throwsCode(() => engine.registerScorecard({ ...scorecard, id: 'dupe-crit', criteria: [{ id: 'a', name: 'A', weight: 1, maxScore: 5 }, { id: 'a', name: 'A2', weight: 1, maxScore: 5 }] }), 'VALIDATION');
  throwsCode(() => engine.registerScorecard({ ...scorecard, id: 'bad-weight', criteria: [{ id: 'a', name: 'A', weight: 0, maxScore: 5 }] }), 'VALIDATION');
  throwsCode(() => engine.registerScorecard({ ...scorecard, id: 'bad-threshold', passThreshold: 101 }), 'VALIDATION');
  assert.equal(engine.getScorecard('support-v1').name, 'Support quality v1');
});
