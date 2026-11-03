import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AutomationEngine, type TicketSnapshot } from '../src/automation/engine.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId, asUserId, type TeamId } from '../src/core/ids.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

function snapshot(overrides: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return { tenantId: tenantA, status: 'new', channel: 'email', priority: 'normal', tags: ['vip'], subject: 'Refund please', description: 'I was charged twice', ...overrides };
}

function newEngine(): AutomationEngine {
  const engine = new AutomationEngine();
  engine.registerRule({ id: 'a-first', priority: 1, trigger: 'ticket_created', conditions: { channels: ['email'], tagsAll: ['vip'] }, actions: { setPriority: 'high', addTags: ['escalated'], notifyTemplateIds: ['t-vip'] } });
  engine.registerRule({ id: 'b-second', priority: 2, trigger: 'ticket_created', conditions: { keywordsAny: ['refund'] }, actions: { setPriority: 'urgent', addTags: ['billing'], removeTags: ['vip'], macroIds: ['m-refund'], assigneeId: asUserId('agent-9') } });
  return engine;
}

test('evaluate applies matching rules in priority order and accumulates actions', () => {
  const decision = newEngine().evaluate('ticket_created', snapshot());
  assert.deepEqual(decision.matchedRules.map((m) => m.ruleId), ['a-first', 'b-second']);
  assert.equal(decision.priority, 'urgent');
  assert.deepEqual(decision.tags, ['escalated', 'billing']);
  assert.deepEqual(decision.macroIds, ['m-refund']);
  assert.deepEqual(decision.notifyTemplateIds, ['t-vip']);
  assert.equal(decision.assigneeId, 'agent-9');
  assert.match(decision.explanation, /a-first/);
  assert.match(decision.explanation, /priority=urgent/);
});

test('evaluate skips other triggers, disabled rules and non-matching conditions, leaving the snapshot unchanged', () => {
  const engine = newEngine();
  engine.registerRule({ id: 'c-disabled', priority: 0, trigger: 'ticket_created', enabled: false, actions: { setPriority: 'low' } });
  engine.registerRule({ id: 'd-chat-only', priority: 0, trigger: 'ticket_created', conditions: { channels: ['chat'] }, actions: { setPriority: 'low' } });
  const wrongTrigger = engine.evaluate('status_changed', snapshot());
  assert.equal(wrongTrigger.matchedRules.length, 0);
  assert.equal(wrongTrigger.priority, 'normal');
  assert.deepEqual(wrongTrigger.tags, ['vip']);
  assert.match(wrongTrigger.explanation, /No automation rules matched/);
  const created = engine.evaluate('ticket_created', snapshot());
  assert.deepEqual(created.matchedRules.map((m) => m.ruleId), ['a-first', 'b-second']);
});

test('a stopProcessing rule halts later rules', () => {
  const engine = new AutomationEngine();
  engine.registerRule({ id: 'stopper', priority: 1, trigger: 'sla_breached', stopProcessing: true, actions: { setPriority: 'urgent' } });
  engine.registerRule({ id: 'after', priority: 2, trigger: 'sla_breached', actions: { addTags: ['late'] } });
  const decision = engine.evaluate('sla_breached', snapshot());
  assert.deepEqual(decision.matchedRules.map((m) => m.ruleId), ['stopper']);
  assert.equal(decision.priority, 'urgent');
  assert.deepEqual(decision.tags, ['vip']);
});

test('rules are tenant-scoped: another tenant rule is ignored and global rules apply to all', () => {
  const engine = new AutomationEngine();
  engine.registerRule({ id: 'for-b', priority: 1, trigger: 'ticket_created', tenantId: tenantB, actions: { setPriority: 'low' } });
  engine.registerRule({ id: 'global', priority: 2, trigger: 'ticket_created', actions: { addTags: ['auto'] } });
  const forA = engine.evaluate('ticket_created', snapshot());
  assert.deepEqual(forA.matchedRules.map((m) => m.ruleId), ['global']);
  assert.deepEqual(engine.listRules(tenantA).map((r) => r.id), ['global']);
  assert.deepEqual(engine.listRules(tenantB).map((r) => r.id), ['for-b', 'global']);
  assert.deepEqual(engine.listRules().map((r) => r.id), ['for-b', 'global']);
});

test('registerRule and registerMacro validate id, priority, actions and duplicates', () => {
  const engine = new AutomationEngine();
  throwsCode(() => engine.registerRule({ id: 'x', priority: 1, trigger: 'ticket_created', actions: { setPriority: 'low' } }), 'VALIDATION');
  throwsCode(() => engine.registerRule({ id: 'ok-id', priority: Number.NaN, trigger: 'ticket_created', actions: { setPriority: 'low' } }), 'VALIDATION');
  throwsCode(() => engine.registerRule({ id: 'ok-id', priority: 1, trigger: 'ticket_created', actions: {} }), 'VALIDATION');
  engine.registerRule({ id: 'ok-id', priority: 1, trigger: 'ticket_created', actions: { setPriority: 'low' } });
  throwsCode(() => engine.registerRule({ id: 'ok-id', priority: 2, trigger: 'ticket_created', actions: { setPriority: 'low' } }), 'CONFLICT');
  throwsCode(() => engine.registerMacro({ id: 'm1', name: 'Empty', actions: {} }), 'VALIDATION');
});

test('macros apply their actions and enforce tenant scope', () => {
  const engine = new AutomationEngine();
  engine.registerMacro({ id: 'm-refund', name: 'Refund flow', actions: { setPriority: 'high', addTags: ['refund'], notifyTemplateIds: ['t-refund'], teamId: 'team-billing' as TeamId } });
  engine.registerMacro({ id: 'm-b-only', name: 'B only', tenantId: tenantB, actions: { setPriority: 'low' } });
  const applied = engine.applyMacro('m-refund', snapshot());
  assert.equal(applied.macroId, 'm-refund');
  assert.equal(applied.priority, 'high');
  assert.deepEqual(applied.tags, ['vip', 'refund']);
  assert.deepEqual(applied.notifyTemplateIds, ['t-refund']);
  assert.equal(applied.teamId, 'team-billing');
  throwsCode(() => engine.applyMacro('missing', snapshot()), 'NOT_FOUND');
  throwsCode(() => engine.applyMacro('m-b-only', snapshot()), 'TENANT_MISMATCH');
  throwsCode(() => engine.registerMacro({ id: 'm-refund', name: 'Dupe', actions: { setPriority: 'low' } }), 'CONFLICT');
});
