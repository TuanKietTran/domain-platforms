import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalyticsEngine, type TicketFact } from '../src/analytics/engine.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId } from '../src/core/ids.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

const facts: readonly TicketFact[] = [
  { tenantId: tenantA, status: 'resolved', priority: 'high', channel: 'email', createdAt: '2026-01-05T09:00:00.000Z', firstResponseAt: '2026-01-05T09:30:00.000Z', resolvedAt: '2026-01-05T11:00:00.000Z', slaBreached: false, csatScore: 5, assigneeId: 'user-1', teamId: 'team-1' },
  { tenantId: tenantA, status: 'closed', priority: 'normal', channel: 'chat', createdAt: '2026-01-05T10:00:00.000Z', firstResponseAt: '2026-01-05T11:00:00.000Z', resolvedAt: '2026-01-05T14:00:00.000Z', slaBreached: true, csatScore: 3, assigneeId: 'user-2', teamId: 'team-1' },
  { tenantId: tenantA, status: 'new', priority: 'urgent', channel: 'email', createdAt: '2026-01-06T09:00:00.000Z', slaBreached: false, teamId: 'team-2' },
  { tenantId: tenantA, status: 'in_progress', priority: 'low', channel: 'web', createdAt: '2026-01-06T10:00:00.000Z', slaBreached: false, assigneeId: 'user-1', teamId: 'team-2' },
  { tenantId: tenantB, status: 'resolved', priority: 'low', channel: 'email', createdAt: '2026-01-05T09:00:00.000Z', resolvedAt: '2026-01-05T10:00:00.000Z', csatScore: 1 },
];

const engine = new AnalyticsEngine();

test('compute aggregates volume, status, channel, assignee and rates for one tenant only', () => {
  const report = engine.compute(facts, { tenantId: tenantA });
  assert.equal(report.total, 4);
  assert.equal(report.open, 2);
  assert.equal(report.resolved, 2);
  assert.deepEqual(report.byStatus, { resolved: 1, closed: 1, new: 1, in_progress: 1 });
  assert.deepEqual(report.byChannel, { email: 2, chat: 1, web: 1 });
  assert.deepEqual(report.byPriority, { high: 1, normal: 1, urgent: 1, low: 1 });
  assert.deepEqual(report.byAssignee, { 'user-1': 2, 'user-2': 1 });
  assert.equal(report.resolutionRate, 50);
  assert.equal(report.slaBreachRate, 25);
});

test('compute averages resolution, first response and CSAT over the facts that have them', () => {
  const report = engine.compute(facts, { tenantId: tenantA });
  assert.equal(report.avgResolutionMinutes, 180);
  assert.equal(report.avgFirstResponseMinutes, 45);
  assert.equal(report.csatAverage, 4);
  const empty = engine.compute(facts, { tenantId: asTenantId('tenant-none') });
  assert.equal(empty.total, 0);
  assert.equal(empty.resolutionRate, 0);
  assert.equal(empty.slaBreachRate, 0);
  assert.equal(empty.avgResolutionMinutes, undefined);
  assert.equal(empty.avgFirstResponseMinutes, undefined);
  assert.equal(empty.csatAverage, undefined);
});

test('compute honours channel, team and date-range filters (from inclusive, to exclusive)', () => {
  assert.equal(engine.compute(facts, { tenantId: tenantA, channel: 'email' }).total, 2);
  assert.equal(engine.compute(facts, { tenantId: tenantA, teamId: 'team-2' }).total, 2);
  assert.equal(engine.compute(facts, { tenantId: tenantA, from: '2026-01-06T00:00:00.000Z', to: '2026-01-07T00:00:00.000Z' }).total, 2);
  assert.equal(engine.compute(facts, { tenantId: tenantA, to: '2026-01-06T00:00:00.000Z' }).total, 2);
});

test('compute rejects invalid ranges, timestamps, CSAT and negative spans', () => {
  throwsCode(() => engine.compute(facts, { tenantId: tenantA, from: 'not-a-date' }), 'VALIDATION');
  throwsCode(() => engine.compute(facts, { tenantId: tenantA, from: '2026-01-07T00:00:00.000Z', to: '2026-01-06T00:00:00.000Z' }), 'VALIDATION');
  const badCsat: TicketFact[] = [{ tenantId: tenantA, status: 'new', priority: 'low', channel: 'web', createdAt: '2026-01-05T09:00:00.000Z', csatScore: 6 }];
  throwsCode(() => engine.compute(badCsat, { tenantId: tenantA }), 'VALIDATION');
  const backwards: TicketFact[] = [{ tenantId: tenantA, status: 'resolved', priority: 'low', channel: 'web', createdAt: '2026-01-05T10:00:00.000Z', resolvedAt: '2026-01-05T09:00:00.000Z' }];
  throwsCode(() => engine.compute(backwards, { tenantId: tenantA }), 'VALIDATION');
});

test('dailyTrend buckets created and resolved per day, sorted, tenant-scoped', () => {
  assert.deepEqual(engine.dailyTrend(facts, { tenantId: tenantA }), [
    { date: '2026-01-05', created: 2, resolved: 2 },
    { date: '2026-01-06', created: 2, resolved: 0 },
  ]);
  const crossDay: TicketFact[] = [{ tenantId: tenantA, status: 'resolved', priority: 'low', channel: 'web', createdAt: '2026-02-01T09:00:00.000Z', resolvedAt: '2026-02-03T09:00:00.000Z' }];
  assert.deepEqual(engine.dailyTrend(crossDay, { tenantId: tenantA }), [
    { date: '2026-02-01', created: 1, resolved: 0 },
    { date: '2026-02-03', created: 0, resolved: 1 },
  ]);
});
