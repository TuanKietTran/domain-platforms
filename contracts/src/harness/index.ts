/** Agent harness core: an offline, deterministic runtime for AI agents over
 * the contract platform. The model is a port; tests drive it with a scripted
 * FakeModel. Every tool call is permission-checked, budget-checked and
 * traced; mutating actions above the configured risk level become proposals
 * that require human approval before execution. No network, no real LLM. */
import { DomainError } from '../core/errors.ts';
import { newAgentRunId, newTraceId, type AgentRunId, type TraceId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext, Permission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';

export interface ModelRequest { readonly system: string; readonly messages: readonly { role: 'user' | 'assistant' | 'tool'; content: string }[]; readonly tools: readonly string[]; }
export type ModelResponse =
  | { kind: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { kind: 'final'; text: string };
export interface Model { complete(req: ModelRequest): Promise<ModelResponse>; readonly name: string; }

/** Scripted deterministic model for tests and offline evals. */
export class FakeModel implements Model {
  readonly name = 'fake-model';
  #script: ModelResponse[];
  readonly requests: ModelRequest[] = [];
  constructor(script: ModelResponse[]) { this.#script = [...script]; }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const next = this.#script.shift();
    if (!next) return { kind: 'final', text: '(script exhausted)' };
    return next;
  }
}

export interface ToolDef {
  readonly name: string; readonly description: string;
  readonly permission: Permission; readonly mutating: boolean;
  readonly risk: 'low' | 'medium' | 'high';
  run(ctx: AccessContext, args: Record<string, unknown>): Promise<unknown> | unknown;
}
export class ToolRegistry {
  #tools = new Map<string, ToolDef>();
  register(t: ToolDef): void {
    if (this.#tools.has(t.name)) throw new DomainError('CONFLICT', `tool already registered: ${t.name}`);
    this.#tools.set(t.name, t);
  }
  get(name: string): ToolDef {
    const t = this.#tools.get(name);
    if (!t) throw new DomainError('NOT_FOUND', `unknown tool: ${name}`);
    return t;
  }
  list(): ToolDef[] { return [...this.#tools.values()]; }
}

export interface TraceEvent {
  readonly traceId: TraceId; readonly runId: AgentRunId; readonly at: string;
  readonly kind: 'run_started' | 'model_call' | 'tool_call' | 'tool_result' | 'proposal_created' | 'run_completed' | 'run_failed';
  readonly detail: Readonly<Record<string, unknown>>;
}
export interface Budget { readonly maxSteps: number; readonly maxToolCalls: number; }
export const DEFAULT_BUDGET: Budget = { maxSteps: 12, maxToolCalls: 10 };

export interface Proposal {
  readonly id: string; readonly runId: AgentRunId; readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>; readonly risk: string;
  readonly status: 'pending' | 'executed' | 'rejected';
}
export type RunStatus = 'completed' | 'failed' | 'budget_exceeded';
export interface RunResult {
  readonly runId: AgentRunId; readonly status: RunStatus;
  readonly finalText: string | null; readonly steps: number; readonly toolCalls: number;
  readonly trace: readonly TraceEvent[]; readonly proposals: readonly Proposal[];
}

export interface HarnessDeps { model: Model; tools: ToolRegistry; clock: Clock; audit: AuditLog; }

export class AgentHarness {
  readonly #deps: HarnessDeps;
  #proposals = new Map<string, Proposal & { ctx: AccessContext }>();
  constructor(deps: HarnessDeps) { this.#deps = deps; }

  async run(ctx: AccessContext, task: string, budget: Budget = DEFAULT_BUDGET): Promise<RunResult> {
    const runId = newAgentRunId(); const traceId = newTraceId();
    const trace: TraceEvent[] = []; const proposals: Proposal[] = [];
    const emit = (kind: TraceEvent['kind'], detail: Record<string, unknown>) =>
      trace.push({ traceId, runId, at: this.#deps.clock.now().toISOString(), kind, detail });
    emit('run_started', { task });
    this.#deps.audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'agent.run.started', subjectType: 'agent_run', subjectId: runId, detail: { task } });
    const messages: { role: 'user' | 'assistant' | 'tool'; content: string }[] = [{ role: 'user', content: task }];
    let steps = 0; let toolCalls = 0;
    const finish = (status: RunStatus, finalText: string | null): RunResult => {
      emit(status === 'completed' ? 'run_completed' : 'run_failed', { status });
      this.#deps.audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'agent.run.completed', subjectType: 'agent_run', subjectId: runId, detail: { status, steps, toolCalls } });
      return { runId, status, finalText, steps, toolCalls, trace, proposals };
    };
    while (true) {
      if (steps >= budget.maxSteps) return finish('budget_exceeded', null);
      steps++;
      emit('model_call', { step: steps });
      let resp: ModelResponse;
      try { resp = await this.#deps.model.complete({ system: 'You operate the contract platform through tools only. Propose, never bypass approvals.', messages, tools: this.#deps.tools.list().map((t) => t.name) }); }
      catch (err) { emit('run_failed', { error: String(err) }); return finish('failed', null); }
      if (resp.kind === 'final') { messages.push({ role: 'assistant', content: resp.text }); return finish('completed', resp.text); }
      if (toolCalls >= budget.maxToolCalls) return finish('budget_exceeded', null);
      const tool = this.#deps.tools.get(resp.tool);
      if (!ctx.permissions.has(tool.permission)) throw new DomainError('FORBIDDEN', `agent context lacks tool permission: ${tool.permission}`, { tool: tool.name });
      toolCalls++;
      emit('tool_call', { tool: tool.name, args: resp.args });
      // High-risk mutations become proposals for human approval.
      if (tool.mutating && tool.risk === 'high') {
        const p: Proposal = { id: `prop_${runId}_${toolCalls}`, runId, tool: tool.name, args: Object.freeze({ ...resp.args }), risk: tool.risk, status: 'pending' };
        this.#proposals.set(p.id, { ...p, ctx }); proposals.push(p);
        emit('proposal_created', { proposalId: p.id, tool: tool.name });
        this.#deps.audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'agent.action.proposed', subjectType: 'agent_run', subjectId: runId, detail: { proposalId: p.id, tool: tool.name } });
        messages.push({ role: 'tool', content: `Proposal ${p.id} created for ${tool.name}; awaiting human approval.` });
        continue;
      }
      const result = await tool.run(ctx, resp.args);
      emit('tool_result', { tool: tool.name, result: JSON.stringify(result).slice(0, 500) });
      messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
  }

  async decideProposal(ctx: AccessContext, proposalId: string, approve: boolean): Promise<unknown> {
    const stored = this.#proposals.get(proposalId);
    if (!stored) throw new DomainError('NOT_FOUND', `proposal not found: ${proposalId}`);
    if (!ctx.permissions.has('agent:approve')) throw new DomainError('APPROVAL_REQUIRED', 'deciding agent proposals requires agent:approve');
    if (stored.status !== 'pending') throw new DomainError('CONFLICT', `proposal already ${stored.status}`);
    if (!approve) { this.#proposals.set(proposalId, { ...stored, status: 'rejected' }); return { rejected: true }; }
    const tool = this.#deps.tools.get(stored.tool);
    const result = await tool.run(stored.ctx, { ...stored.args });
    this.#proposals.set(proposalId, { ...stored, status: 'executed' });
    return result;
  }
}

/** Minimal eval runner: scripted scenarios with pass/fail assertions. */
export interface EvalCase { readonly name: string; readonly run: () => Promise<void>; }
export async function runEvals(cases: EvalCase[]): Promise<{ passed: number; failed: { name: string; error: string }[] }> {
  let passed = 0; const failed: { name: string; error: string }[] = [];
  for (const c of cases) { try { await c.run(); passed++; } catch (err) { failed.push({ name: c.name, error: err instanceof Error ? err.message : String(err) }); } }
  return { passed, failed };
}
