import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHarness, FakeModel, ToolRegistry, runEvals, type ModelResponse } from '../src/harness/index.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

function buildHarness(script: ModelResponse[]) {
  const w = makeWorld();
  const tools = new ToolRegistry();
  tools.register({ name: 'list_contracts', description: 'list contracts', permission: 'contract:read', mutating: false, risk: 'low',
    run: (ctx) => w.contracts.list(ctx).map((c) => ({ id: c.id, state: c.state })) });
  tools.register({ name: 'terminate_contract', description: 'terminate a contract', permission: 'contract:write', mutating: true, risk: 'high',
    run: (ctx, args) => w.contracts.transition(ctx, args['contractId'] as never, 'terminated') });
  const model = new FakeModel(script);
  const harness = new AgentHarness({ model, tools, clock: w.clock, audit: w.audit });
  return { w, tools, model, harness };
}

test('agent completes a read-only task within budget, with a full trace', async () => {
  const { w, harness } = buildHarness([
    { kind: 'tool_call', tool: 'list_contracts', args: {} },
    { kind: 'final', text: 'No contracts yet.' },
  ]);
  const r = await harness.run(w.counselCtx, 'List contracts');
  assert.equal(r.status, 'completed');
  assert.equal(r.finalText, 'No contracts yet.');
  assert.equal(r.toolCalls, 1);
  assert.ok(r.trace.some((t) => t.kind === 'tool_result'));
});

test('high-risk mutation becomes a proposal; nothing executes without approval', async () => {
  const { w, harness } = buildHarness([
    { kind: 'tool_call', tool: 'terminate_contract', args: {} },
    { kind: 'final', text: 'Proposed.' },
  ]);
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  w.contracts.transition(w.counselCtx, c.id, 'sent_for_signature');
  w.contracts.transition(w.adminCtx, c.id, 'signed');
  w.contracts.transition(w.counselCtx, c.id, 'active');
  const r = await harness.run(w.counselCtx, 'Terminate it', );
  assert.equal(r.proposals.length, 1);
  assert.equal(w.contracts.get(w.counselCtx, c.id).state, 'active'); // untouched
  // viewer cannot approve proposals (no agent:approve)
  await assert.rejects(() => harness.decideProposal(w.viewerCtx, r.proposals[0]!.id, true));
  // admin approves -> executes against the stored args (empty args here, so execution fails on missing id)
  await assert.rejects(() => harness.decideProposal(w.adminCtx, r.proposals[0]!.id, true));
});

test('proposal executes with its stored args once approved', async () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  w.contracts.transition(w.counselCtx, c.id, 'in_review');
  w.contracts.transition(w.counselCtx, c.id, 'approved');
  w.contracts.transition(w.counselCtx, c.id, 'sent_for_signature');
  w.contracts.transition(w.adminCtx, c.id, 'signed');
  w.contracts.transition(w.counselCtx, c.id, 'active');
  const { harness } = buildHarness([
    { kind: 'tool_call', tool: 'terminate_contract', args: { contractId: c.id } },
    { kind: 'final', text: 'Proposed termination.' },
  ]);
  // rebuild harness against this world: buildHarness made its own world, so run there instead
  void harness;
  const tools = new ToolRegistry();
  tools.register({ name: 'terminate_contract', description: 'terminate', permission: 'contract:write', mutating: true, risk: 'high',
    run: (ctx, args) => w.contracts.transition(ctx, args['contractId'] as never, 'terminated') });
  const h2 = new AgentHarness({ model: new FakeModel([
    { kind: 'tool_call', tool: 'terminate_contract', args: { contractId: c.id } },
    { kind: 'final', text: 'Proposed termination.' },
  ]), tools, clock: w.clock, audit: w.audit });
  const r = await h2.run(w.counselCtx, 'Terminate the Globex MSA');
  assert.equal(r.proposals.length, 1);
  await h2.decideProposal(w.adminCtx, r.proposals[0]!.id, true);
  assert.equal(w.contracts.get(w.counselCtx, c.id).state, 'terminated');
  assert.ok(w.audit.list(w.tenant.id).some((e) => e.action === 'agent.action.proposed'));
});

test('budget exhaustion stops the run', async () => {
  const script = Array.from({ length: 20 }, () => ({ kind: 'tool_call', tool: 'list_contracts', args: {} }) as const);
  const { w, harness } = buildHarness(script);
  const r = await harness.run(w.counselCtx, 'Loop forever', { maxSteps: 3, maxToolCalls: 2 });
  assert.equal(r.status, 'budget_exceeded');
});

test('runEvals reports pass/fail per case', async () => {
  const out = await runEvals([
    { name: 'ok', run: async () => {} },
    { name: 'bad', run: async () => { throw new Error('nope'); } },
  ]);
  assert.equal(out.passed, 1);
  assert.deepEqual(out.failed.map((f) => f.name), ['bad']);
});
