import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../src/core/errors.js';
import { asCustomerId, asTenantId, asTicketId, asUserId } from '../src/core/ids.js';
import { applyTransition, availableActions, describeLifecycle, TRANSITIONS, transitionFor } from '../src/tickets/state-machine.js';
import type { Ticket, TicketStatus } from '../src/tickets/types.js';

const AT = '2026-01-05T10:00:00.000Z';
const STATUSES: readonly TicketStatus[] = ['new', 'triaged', 'in_progress', 'pending_customer', 'pending_third_party', 'resolved', 'closed'];

function ticket(status: TicketStatus, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: asTicketId('tkt_1'), tenantId: asTenantId('tenant-a'), number: 1,
    subject: 'Help', description: 'Something broke', status, priority: 'normal', channel: 'email',
    requesterId: asCustomerId('cus_1'), assigneeId: asUserId('usr_1'), tags: [], language: 'en',
    createdAt: AT, updatedAt: AT, reopenCount: 0, version: 1, transitions: [], customFields: {}, ...overrides,
  };
}
function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}
const req = (action: (typeof TRANSITIONS)[number]['action'], extra: object = {}) => ({ action, at: AT, actorId: 'usr_1', ...extra });

test('every legal transition succeeds, bumps version, records history and leaves the original untouched', () => {
  for (const def of TRANSITIONS) {
    for (const from of def.from) {
      const before = ticket(from);
      const extra = def.requiresResolutionSummary ? { resolutionSummary: 'Fixed it' } : {};
      const result = applyTransition(before, req(def.action, extra));
      assert.equal(result.from, from, `${def.action} from ${from}`);
      assert.equal(result.to, def.to, `${def.action} from ${from}`);
      assert.equal(result.ticket.status, def.to);
      assert.equal(result.ticket.version, before.version + 1);
      assert.equal(result.ticket.updatedAt, AT);
      assert.equal(result.ticket.transitions.length, 1);
      assert.deepEqual(result.ticket.transitions[0], { action: def.action, from, to: def.to, at: AT, actorId: 'usr_1', reason: undefined });
      assert.equal(before.status, from);
      assert.equal(before.transitions.length, 0);
    }
  }
});

test('every illegal transition is rejected with TRANSITION_NOT_ALLOWED and no state is produced', () => {
  for (const def of TRANSITIONS) {
    for (const status of STATUSES) {
      if (def.from.includes(status)) continue;
      throwsCode(() => applyTransition(ticket(status), req(def.action, { resolutionSummary: 'x' })), 'TRANSITION_NOT_ALLOWED');
    }
  }
});

test('a closed ticket rejects every action except reopen', () => {
  for (const def of TRANSITIONS) {
    if (def.action === 'reopen') continue;
    throwsCode(() => applyTransition(ticket('closed'), req(def.action, { resolutionSummary: 'x' })), 'TRANSITION_NOT_ALLOWED');
  }
  assert.equal(applyTransition(ticket('closed'), req('reopen')).ticket.status, 'in_progress');
});

test('resolve requires a non-blank summary and stamps resolvedAt and the summary', () => {
  throwsCode(() => applyTransition(ticket('in_progress'), req('resolve')), 'VALIDATION');
  throwsCode(() => applyTransition(ticket('in_progress'), req('resolve', { resolutionSummary: '   ' })), 'VALIDATION');
  const result = applyTransition(ticket('in_progress'), req('resolve', { resolutionSummary: '  Fixed it  ' }));
  assert.equal(result.ticket.resolvedAt, AT);
  assert.equal(result.timestamps.resolvedAt, AT);
  assert.equal(result.ticket.resolutionSummary, 'Fixed it');
  assert.equal(result.timestamps.reopened, false);
});

test('close and cancel stamp closedAt; close is only reachable from resolved', () => {
  const closed = applyTransition(ticket('resolved'), req('close'));
  assert.equal(closed.ticket.closedAt, AT);
  assert.equal(closed.timestamps.closedAt, AT);
  const cancelled = applyTransition(ticket('new'), req('cancel'));
  assert.equal(cancelled.ticket.status, 'closed');
  assert.equal(cancelled.ticket.closedAt, AT);
  throwsCode(() => applyTransition(ticket('in_progress'), req('close')), 'TRANSITION_NOT_ALLOWED');
});

test('reopen from resolved or closed increments reopenCount and clears resolution fields', () => {
  for (const from of ['resolved', 'closed'] as const) {
    const before = ticket(from, { resolvedAt: AT, resolutionSummary: 'Done', reopenCount: 2 });
    const result = applyTransition(before, req('reopen'));
    assert.equal(result.ticket.status, 'in_progress');
    assert.equal(result.ticket.reopenCount, 3);
    assert.equal(result.ticket.resolvedAt, undefined);
    assert.equal(result.ticket.closedAt, undefined);
    assert.equal(result.ticket.resolutionSummary, undefined);
    assert.equal(result.timestamps.reopened, true);
  }
});

test('pending states resume to in_progress and pending requests move between pending states', () => {
  assert.equal(applyTransition(ticket('pending_customer'), req('resume')).ticket.status, 'in_progress');
  assert.equal(applyTransition(ticket('pending_third_party'), req('resume')).ticket.status, 'in_progress');
  assert.equal(applyTransition(ticket('pending_third_party'), req('request_customer_info')).ticket.status, 'pending_customer');
  assert.equal(applyTransition(ticket('pending_customer'), req('request_third_party')).ticket.status, 'pending_third_party');
});

test('a transition can reassign assignee and team, otherwise they are preserved', () => {
  const moved = applyTransition(ticket('new'), req('triage', { assigneeId: asUserId('usr_9') }));
  assert.equal(moved.ticket.assigneeId, asUserId('usr_9'));
  const kept = applyTransition(ticket('new'), req('triage'));
  assert.equal(kept.ticket.assigneeId, asUserId('usr_1'));
});

test('availableActions, transitionFor and describeLifecycle reflect TRANSITIONS', () => {
  assert.deepEqual(availableActions(ticket('new')).map((d) => d.action), ['triage', 'cancel']);
  assert.deepEqual(availableActions(ticket('closed')).map((d) => d.action), ['reopen']);
  assert.deepEqual(availableActions(ticket('resolved')).map((d) => d.action), ['close', 'reopen']);
  assert.equal(transitionFor('resolve').to, 'resolved');
  throwsCode(() => transitionFor('bogus' as never), 'VALIDATION');
  const docs = describeLifecycle();
  assert.equal(docs.length, 7);
  assert.deepEqual(docs.map((d) => d.status), STATUSES);
  assert.equal(docs.find((d) => d.status === 'new')?.actions.length, 2);
});
