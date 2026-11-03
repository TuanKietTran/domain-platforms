import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../src/core/errors.js';
import { addBusinessMinutes, ALWAYS_ON, businessMinutesBetween, DEFAULT_CALENDAR, SlaEngine, type SlaPolicy } from '../src/sla/engine.js';

const MON_0900 = '2026-01-05T09:00:00.000Z';
function policy(overrides: Partial<SlaPolicy> = {}): SlaPolicy {
  return {
    id: 'pol-1', tenantId: 'tenant-a', name: 'Standard', priority: 'high', businessHours: true, pauseOnPendingCustomer: true,
    targets: [{ kind: 'first_response', minutes: 60 }, { kind: 'resolution', minutes: 480 }], ...overrides,
  };
}
function engine(p: SlaPolicy = policy()): SlaEngine { const e = new SlaEngine(); e.registerPolicy(p); return e; }
function throwsCode(fn: () => unknown, code: string): void { assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code); }

test('addBusinessMinutes stays inside the working day and skips weekends, evenings and holidays', () => {
  assert.equal(addBusinessMinutes(MON_0900, 60).toISOString(), '2026-01-05T10:00:00.000Z');
  assert.equal(addBusinessMinutes('2026-01-09T16:00:00.000Z', 120).toISOString(), '2026-01-12T10:00:00.000Z');
  assert.equal(addBusinessMinutes('2026-01-05T07:30:00.000Z', 60).toISOString(), '2026-01-05T10:00:00.000Z');
  assert.equal(addBusinessMinutes('2026-01-05T16:30:00.000Z', 60).toISOString(), '2026-01-06T09:30:00.000Z');
  const holiday = { ...DEFAULT_CALENDAR, holidays: ['2026-01-05'] };
  assert.equal(addBusinessMinutes(MON_0900, 60, holiday).toISOString(), '2026-01-06T10:00:00.000Z');
  assert.equal(addBusinessMinutes(MON_0900, 0).toISOString(), MON_0900);
  throwsCode(() => addBusinessMinutes(MON_0900, -1), 'VALIDATION');
});

test('addBusinessMinutes on a 24/7 calendar is plain wall-clock, weekends included', () => {
  assert.equal(addBusinessMinutes('2026-01-10T09:00:00.000Z', 90, ALWAYS_ON).toISOString(), '2026-01-10T10:30:00.000Z');
});

test('businessMinutesBetween counts only working time', () => {
  assert.equal(businessMinutesBetween(MON_0900, '2026-01-05T17:00:00.000Z'), 480);
  assert.equal(businessMinutesBetween(MON_0900, '2026-01-06T09:00:00.000Z'), 480);
  assert.equal(businessMinutesBetween('2026-01-09T16:00:00.000Z', '2026-01-12T10:00:00.000Z'), 120);
  assert.equal(businessMinutesBetween('2026-01-05T07:00:00.000Z', '2026-01-05T10:00:00.000Z'), 60);
  assert.equal(businessMinutesBetween('2026-01-10T09:00:00.000Z', '2026-01-12T10:00:00.000Z'), 60);
});

test('registerPolicy validates targets and selectPolicy prefers exact priority then default', () => {
  const e = new SlaEngine();
  throwsCode(() => e.registerPolicy(policy({ targets: [] })), 'VALIDATION');
  throwsCode(() => e.registerPolicy(policy({ targets: [{ kind: 'resolution', minutes: 0 }] })), 'VALIDATION');
  throwsCode(() => e.registerPolicy(policy({ targets: [{ kind: 'resolution', minutes: 10 }, { kind: 'resolution', minutes: 20 }] })), 'VALIDATION');
  throwsCode(() => e.getPolicy('missing'), 'NOT_FOUND');
  e.registerPolicy(policy());
  e.registerPolicy(policy({ id: 'pol-default', priority: 'default' }));
  e.registerPolicy(policy({ id: 'pol-other', tenantId: 'tenant-b', priority: 'low' }));
  assert.equal(e.selectPolicy('tenant-a', 'high').id, 'pol-1');
  assert.equal(e.selectPolicy('tenant-a', 'low').id, 'pol-default');
  throwsCode(() => e.selectPolicy('tenant-b', 'urgent'), 'NOT_FOUND');
  assert.deepEqual(e.listPolicies('tenant-a').map((p) => p.id), ['pol-1', 'pol-default']);
});

test('createTracker computes business-hours deadlines; a 24/7 policy uses wall clock', () => {
  const tracker = engine().createTracker(policy(), 'high', MON_0900);
  assert.equal(tracker.policyId, 'pol-1');
  assert.equal(tracker.pausedMinutes, 0);
  assert.equal(tracker.targets.find((t) => t.kind === 'first_response')?.dueAt, '2026-01-05T10:00:00.000Z');
  assert.equal(tracker.targets.find((t) => t.kind === 'resolution')?.dueAt, '2026-01-05T17:00:00.000Z');
  const always = engine(policy({ businessHours: false })).createTracker(policy({ businessHours: false }), 'high', '2026-01-10T09:00:00.000Z');
  assert.equal(always.targets.find((t) => t.kind === 'first_response')?.dueAt, '2026-01-10T10:00:00.000Z');
});

test('pause freezes remaining time, is idempotent, and resume shifts deadlines by the paused business time', () => {
  const e = engine();
  const tracker = e.createTracker(policy(), 'high', MON_0900);
  const paused = e.pause(tracker, '2026-01-05T09:30:00.000Z', 'waiting on customer');
  assert.equal(paused.pausedAt, '2026-01-05T09:30:00.000Z');
  assert.equal(paused.pauseReason, 'waiting on customer');
  assert.equal(paused.targets.find((t) => t.kind === 'first_response')?.remainingMinutesAtPause, 30);
  assert.equal(paused.targets.find((t) => t.kind === 'resolution')?.remainingMinutesAtPause, 450);
  assert.equal(e.pause(paused, '2026-01-05T10:00:00.000Z', 'again'), paused);
  const resumed = e.resume(paused, '2026-01-05T11:00:00.000Z');
  assert.equal(resumed.pausedAt, undefined);
  assert.equal(resumed.pausedMinutes, 90);
  assert.equal(resumed.targets.find((t) => t.kind === 'first_response')?.dueAt, '2026-01-05T11:30:00.000Z');
  assert.equal(resumed.targets.find((t) => t.kind === 'resolution')?.dueAt, '2026-01-06T10:30:00.000Z');
  assert.equal(e.resume(resumed, '2026-01-05T12:00:00.000Z'), resumed);
});

test('evaluate reports pending, at_risk, breached, met and paused states', () => {
  const e = engine();
  const tracker = e.createTracker(policy(), 'high', MON_0900);
  const at = (iso: string, kind: string) => e.evaluate(tracker, iso).find((x) => x.kind === kind);
  assert.equal(at('2026-01-05T09:30:00.000Z', 'first_response')?.status, 'pending');
  assert.equal(at('2026-01-05T09:50:00.000Z', 'first_response')?.status, 'at_risk');
  assert.equal(at('2026-01-05T09:50:00.000Z', 'first_response')?.remainingMinutes, 10);
  const late = at('2026-01-05T10:30:00.000Z', 'first_response');
  assert.equal(late?.status, 'breached');
  assert.equal(late?.remainingMinutes, -30);
  const met = e.markMet(tracker, 'first_response', '2026-01-05T09:45:00.000Z');
  assert.equal(e.evaluate(met, '2026-01-05T12:00:00.000Z').find((x) => x.kind === 'first_response')?.status, 'met');
  const paused = e.pause(tracker, '2026-01-05T09:30:00.000Z', 'waiting');
  const pausedEval = e.evaluate(paused, '2026-01-05T12:00:00.000Z').find((x) => x.kind === 'first_response');
  assert.equal(pausedEval?.status, 'pending');
  assert.match(pausedEval?.explanation ?? '', /Paused at/);
});

test('breaches lists overdue unmet targets once, recordBreach marks and notifies once, reopenTarget resets a target', () => {
  const e = engine();
  const tracker = e.createTracker(policy(), 'high', MON_0900);
  assert.deepEqual(e.breaches(tracker, '2026-01-05T09:30:00.000Z'), []);
  assert.deepEqual(e.breaches(tracker, '2026-01-05T10:30:00.000Z'), [{ kind: 'first_response', dueAt: '2026-01-05T10:00:00.000Z', minutesLate: 30 }]);
  const recorded = e.recordBreach(tracker, 'first_response', '2026-01-05T10:30:00.000Z');
  assert.deepEqual(e.breaches(recorded, '2026-01-05T11:00:00.000Z'), []);
  assert.deepEqual(e.recordBreach(recorded, 'first_response', '2026-01-05T11:00:00.000Z').breachNotified, ['first_response']);
  assert.equal(e.evaluate(recorded, '2026-01-05T11:00:00.000Z').find((x) => x.kind === 'first_response')?.status, 'breached');
  const met = e.markMet(tracker, 'resolution', '2026-01-05T12:00:00.000Z');
  assert.deepEqual(e.breaches(met, '2026-01-06T12:00:00.000Z').map((b) => b.kind), ['first_response']);
  const reopened = e.reopenTarget(met, 'resolution', '2026-01-06T09:00:00.000Z');
  const target = reopened.targets.find((t) => t.kind === 'resolution');
  assert.equal(target?.metAt, undefined);
  assert.equal(target?.dueAt, '2026-01-06T17:00:00.000Z');
  assert.equal(e.reopenTarget(tracker, 'next_response', MON_0900), tracker);
});
