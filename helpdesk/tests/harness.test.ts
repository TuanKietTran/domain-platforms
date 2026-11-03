import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditLog } from '../src/core/audit.js';
import { FakeClock } from '../src/core/clock.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId, SequentialIdGenerator, type TenantId } from '../src/core/ids.js';
import { analyzeSentiment, autoResolve, classifyTicket, draftReply, registerBuiltInAgents, summarizeThread, type AutoResolveAssessment, type Classification, type DraftReply, type SentimentResult, type ThreadSummary } from '../src/harness/agents.js';
import { AgentHarness } from '../src/harness/harness.js';
import { countTokens, FakeModel } from '../src/harness/model.js';
import type { ActionExecutor, AgentRun, ProposedAction } from '../src/harness/types.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

class SpyExecutor implements ActionExecutor {
  readonly calls: ProposedAction[] = [];
  execute(action: ProposedAction, _tenantId: TenantId): string {
    this.calls.push(action);
    return `done:${action.kind}:${action.ticketId ?? ''}`;
  }
}

function newHarness(executor?: SpyExecutor): { harness: AgentHarness; audit: AuditLog } {
  const audit = new AuditLog(new FakeClock('2026-01-05T09:00:00.000Z'), new SequentialIdGenerator());
  const harness = new AgentHarness(new SequentialIdGenerator(), new FakeClock('2026-01-05T09:00:00.000Z'), audit, new FakeModel(), executor);
  registerBuiltInAgents(harness);
  return { harness, audit };
}

function out<T>(run: AgentRun): T { return run.output as T; }

test('registerAgent validates budgets and duplicates; built-ins register five agents', () => {
  const { harness } = newHarness();
  assert.deepEqual(harness.listAgents().map((a) => a.id), ['classifier', 'drafter', 'summarizer', 'sentiment', 'auto-resolver']);
  throwsCode(() => harness.registerAgent({ id: 'classifier', name: 'dup', permissions: [], budget: { maxTokensPerRun: 10, maxCostPerRun: 1 }, costPerThousandTokens: 0 }), 'CONFLICT');
  throwsCode(() => harness.registerAgent({ id: 'bad-budget', name: 'bad', permissions: [], budget: { maxTokensPerRun: 0, maxCostPerRun: 1 }, costPerThousandTokens: 0 }), 'VALIDATION');
  throwsCode(() => harness.getAgent('nope'), 'NOT_FOUND');
});

test('FakeModel is deterministic, templates drafts, and counts tokens by words', () => {
  const model = new FakeModel();
  const request = { task: 'draft_reply', prompt: 'Invoice payment failed. Please help.', context: { subject: 'Invoice payment failed', customerName: 'Sam' } };
  const a = model.generate(request);
  const b = model.generate(request);
  assert.deepEqual(a, b);
  assert.ok(a.text.includes('Hi Sam'));
  assert.ok(a.text.includes('"Invoice payment failed"'));
  assert.equal(a.inputTokens, countTokens(`draft_reply ${request.prompt}`));
  assert.equal(a.totalTokens, a.inputTokens + a.outputTokens);
  const custom = new FakeModel((req) => (req.task === 'x' ? 'custom text' : undefined));
  assert.equal(custom.generate({ task: 'x', prompt: 'p' }).text, 'custom text');
  assert.ok(custom.generate({ task: 'other', prompt: 'Hello world.' }).text.includes('fake-model[other]'));
});

test('a run without the required permission is POLICY_DENIED, audited as denied, and executes nothing', () => {
  const executor = new SpyExecutor();
  const { harness, audit } = newHarness(executor);
  throwsCode(() => harness.run({ tenantId: tenantA, agentId: 'classifier', task: 'classification', permission: 'ticket:close', execute: () => ({ output: {} }) }), 'POLICY_DENIED');
  assert.equal(harness.listRuns(tenantA).length, 0);
  assert.equal(executor.calls.length, 0);
  const denied = audit.exportEntries().filter((e) => e.outcome === 'denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0]?.actor.kind, 'agent');
  assert.equal(audit.verify().valid, true);
});

test('classifyTicket picks the best category, derives priority, and completes without executing', () => {
  const executor = new SpyExecutor();
  const { harness } = newHarness(executor);
  const billing = classifyTicket(harness, tenantA, { ticketId: 'tkt_1', subject: 'Invoice payment failed', description: 'My payment for the invoice was charged twice' });
  const billingOut = out<Classification>(billing);
  assert.equal(billing.status, 'completed');
  assert.equal(billing.executed, false);
  assert.equal(billingOut.category, 'billing');
  assert.equal(billingOut.priority, 'normal');
  assert.equal(billingOut.confidence, 0.8);
  const urgent = classifyTicket(harness, tenantA, { ticketId: 'tkt_2', subject: 'Urgent outage: locked out', description: 'Cannot access my account at all' });
  const urgentOut = out<Classification>(urgent);
  assert.equal(urgentOut.category, 'account');
  assert.equal(urgentOut.priority, 'urgent');
  assert.equal(executor.calls.length, 0);
});

test('draftReply uses the FakeModel draft and passes citations through; summarizeThread is extractive', () => {
  const { harness } = newHarness();
  const draft = draftReply(harness, tenantA, { ticketId: 'tkt_1', subject: 'Invoice payment failed', description: 'Charged twice', customerName: 'Sam', citations: [{ articleId: 'art_000001', version: 2 }] });
  const draftOut = out<DraftReply>(draft);
  assert.ok(draftOut.draft.includes('Hi Sam'));
  assert.deepEqual(draftOut.citations, [{ articleId: 'art_000001', version: 2 }]);
  assert.equal(draft.proposedAction?.kind, 'suggest_reply');
  assert.ok(draft.totalTokens > 0);
  const summary = summarizeThread(harness, tenantA, 'tkt_1', [
    { authorKind: 'customer', body: 'I cannot log in. It started yesterday.' },
    { authorKind: 'agent', body: 'Thanks, checking now. One moment.' },
    { authorKind: 'customer', body: 'Still broken today.' },
  ]);
  const summaryOut = out<ThreadSummary>(summary);
  assert.equal(summaryOut.messageCount, 3);
  assert.deepEqual(summaryOut.participants, ['customer', 'agent']);
  assert.deepEqual(summaryOut.keyPoints, ['I cannot log in.', 'Thanks, checking now.', 'Still broken today.']);
});

test('analyzeSentiment scores lexicon signals and flags urgency', () => {
  const { harness } = newHarness();
  const negative = analyzeSentiment(harness, tenantA, { ticketId: 'tkt_1', subject: 'Terrible and urgent', description: 'I am furious about this' });
  const negOut = out<SentimentResult>(negative);
  assert.equal(negOut.sentiment, 'negative');
  assert.equal(negOut.score, -2);
  assert.equal(negOut.urgency, 'high');
  const positive = analyzeSentiment(harness, tenantA, { ticketId: 'tkt_2', subject: 'Great help', description: 'Thanks, excellent work' });
  assert.equal(out<SentimentResult>(positive).sentiment, 'positive');
});

test('a run exceeding its token budget is BUDGET_EXHAUSTED and leaves no completed run', () => {
  const { harness, audit } = newHarness();
  harness.registerAgent({ id: 'tiny', name: 'Tiny', permissions: ['ticket:classify'], budget: { maxTokensPerRun: 5, maxCostPerRun: 100 }, costPerThousandTokens: 0 });
  throwsCode(() => harness.run({ tenantId: tenantA, agentId: 'tiny', task: 'classification', permission: 'ticket:classify', execute: () => ({ output: { text: 'one two three four five six seven eight nine ten' } }) }), 'BUDGET_EXHAUSTED');
  assert.equal(harness.listRuns(tenantA, 'tiny').length, 0);
  assert.equal(audit.exportEntries().filter((e) => e.outcome === 'failed').length, 1);
});

test('auto-resolve of a low-risk ticket waits for approval; approve executes exactly once', () => {
  const executor = new SpyExecutor();
  const { harness } = newHarness(executor);
  const run = autoResolve(harness, tenantA, { ticketId: 'tkt_1', subject: 'Password reset', description: 'Please help me reset password for my account' });
  assert.equal(out<AutoResolveAssessment>(run).recommendation, 'resolve');
  assert.equal(out<AutoResolveAssessment>(run).risk, 'low');
  assert.equal(run.status, 'pending_approval');
  assert.equal(run.executed, false);
  assert.equal(run.proposedAction?.kind, 'resolve_ticket');
  assert.equal(executor.calls.length, 0);
  const approved = harness.approve(run.id, tenantA, 'usr_lead');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.executed, true);
  assert.equal(approved.executionResult, 'done:resolve_ticket:tkt_1');
  assert.equal(approved.decidedBy, 'usr_lead');
  assert.equal(executor.calls.length, 1);
  throwsCode(() => harness.approve(run.id, tenantA, 'usr_lead'), 'CONFLICT');
  assert.equal(executor.calls.length, 1);
});

test('AI never closes or escalates without approval, and rejection executes nothing', () => {
  const executor = new SpyExecutor();
  const { harness } = newHarness(executor);
  const close = harness.run({ tenantId: tenantA, agentId: 'auto-resolver', task: 'close_ticket', permission: 'ticket:close', execute: () => ({ output: { note: 'spam' }, proposedAction: { kind: 'close_ticket', ticketId: 'tkt_9', summary: 'Close as spam' } }) });
  assert.equal(close.status, 'pending_approval');
  assert.equal(executor.calls.length, 0);
  const rejected = harness.reject(close.id, tenantA, 'usr_lead');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.executed, false);
  assert.equal(executor.calls.length, 0);
  const escalate = harness.run({ tenantId: tenantA, agentId: 'auto-resolver', task: 'escalate_ticket', permission: 'ticket:escalate', execute: () => ({ output: { note: 'sla risk' }, proposedAction: { kind: 'escalate_ticket', ticketId: 'tkt_10', summary: 'Escalate to L2' } }) });
  assert.equal(escalate.status, 'pending_approval');
  assert.equal(executor.calls.length, 0);
  harness.approve(escalate.id, tenantA, 'usr_lead');
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0]?.kind, 'escalate_ticket');
});

test('auto-resolve of a high-risk ticket recommends manual review and proposes no action', () => {
  const executor = new SpyExecutor();
  const { harness } = newHarness(executor);
  const run = autoResolve(harness, tenantA, { ticketId: 'tkt_3', subject: 'Refund now', description: 'Terrible service, payment failed and I am furious' });
  const assessment = out<AutoResolveAssessment>(run);
  assert.equal(assessment.recommendation, 'manual_review');
  assert.equal(assessment.risk, 'high');
  assert.equal(run.status, 'completed');
  assert.equal(run.proposedAction, undefined);
  assert.equal(executor.calls.length, 0);
});

test('runs are tenant-scoped and every run plus decision lands in the audit log as a trace', () => {
  const executor = new SpyExecutor();
  const { harness, audit } = newHarness(executor);
  const run = autoResolve(harness, tenantA, { ticketId: 'tkt_1', subject: 'Password reset', description: 'Please help me reset password' });
  throwsCode(() => harness.getRun(run.id, tenantB), 'NOT_FOUND');
  throwsCode(() => harness.approve(run.id, tenantB, 'usr_lead'), 'NOT_FOUND');
  assert.equal(executor.calls.length, 0);
  assert.equal(harness.listRuns(tenantB).length, 0);
  harness.approve(run.id, tenantA, 'usr_lead');
  const entries = audit.exportEntries();
  assert.equal(audit.verify().valid, true);
  const trace = entries.find((e) => e.action === 'agent.run.auto_resolve');
  assert.equal(trace?.actor.kind, 'agent');
  assert.equal(trace?.metadata.proposedAction, 'resolve_ticket');
  assert.ok(entries.some((e) => e.action === 'agent.approve'));
  const usage = harness.usage(tenantA);
  assert.equal(usage.runs, 1);
  assert.equal(usage.totalTokens, run.totalTokens);
  assert.equal(usage.totalCost, run.cost);
});
