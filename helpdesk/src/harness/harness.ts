import type { AuditLog } from '../core/audit.js';
import { SystemClock, type Clock } from '../core/clock.js';
import { DomainError } from '../core/errors.js';
import type { IdGenerator, RunId, TenantId } from '../core/ids.js';
import { cloneJson, deepFreeze, round, unique } from '../core/util.js';
import { countTokens, FakeModel } from './model.js';
import { isGatedAction, type ActionExecutor, type AgentDefinition, type AgentRun, type AgentUsage, type Model, type ModelRequest, type ModelResponse, type RunAgentRequest } from './types.js';

class TrackingModel implements Model {
  inputTokens = 0;
  outputTokens = 0;
  constructor(private readonly inner: Model) {}
  generate(request: ModelRequest): ModelResponse {
    const response = this.inner.generate(request);
    this.inputTokens += response.inputTokens;
    this.outputTokens += response.outputTokens;
    return response;
  }
  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }
}

/**
 * Agent harness core. Every run is permission-checked against the agent's
 * registered permissions, token/cost-budgeted, and written to the audit log
 * as an evaluation trace. A run proposing a gated action (resolve, close,
 * escalate) ends in pending_approval and is NEVER executed by run(); the
 * action executor is invoked exactly once, from approve(), by a human.
 */
export class AgentHarness {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly runs = new Map<string, AgentRun>();

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock = new SystemClock(),
    private readonly audit?: AuditLog,
    private readonly model: Model = new FakeModel(),
    private readonly executor?: ActionExecutor,
  ) {}

  registerAgent(definition: AgentDefinition): AgentDefinition {
    const id = definition.id.trim();
    if (id.length < 2) throw new DomainError('VALIDATION', 'Agent id is too short');
    if (definition.budget.maxTokensPerRun <= 0 || definition.budget.maxCostPerRun <= 0) {
      throw new DomainError('VALIDATION', 'Agent budget limits must be positive');
    }
    if (definition.costPerThousandTokens < 0) throw new DomainError('VALIDATION', 'Agent cost cannot be negative');
    if (this.agents.has(id)) throw new DomainError('CONFLICT', 'Agent already registered', { agentId: id });
    const stored: AgentDefinition = deepFreeze({ ...definition, id, permissions: unique(definition.permissions) });
    this.agents.set(id, stored);
    return stored;
  }

  getAgent(agentId: string): AgentDefinition {
    const agent = this.agents.get(agentId);
    if (!agent) throw new DomainError('NOT_FOUND', 'Agent not found', { agentId });
    return agent;
  }

  listAgents(): readonly AgentDefinition[] {
    return [...this.agents.values()];
  }

  run<T>(request: RunAgentRequest<T>): AgentRun {
    const agent = this.getAgent(request.agentId);
    if (!agent.permissions.includes(request.permission)) {
      this.trace(request.tenantId, agent.id, request.task, 'denied', `Agent ${agent.id} denied ${request.permission} for ${request.task}`, undefined, { permission: request.permission });
      throw new DomainError('POLICY_DENIED', 'Agent lacks the required permission', { agentId: agent.id, permission: request.permission });
    }
    const tracking = new TrackingModel(this.model);
    const result = request.execute(tracking);
    const outputTokens = tracking.totalTokens > 0 ? tracking.outputTokens : countTokens(JSON.stringify(result.output) ?? '');
    const inputTokens = tracking.totalTokens > 0 ? tracking.inputTokens : countTokens(request.task);
    const totalTokens = inputTokens + outputTokens;
    const cost = round((totalTokens / 1000) * agent.costPerThousandTokens, 6);
    if (totalTokens > agent.budget.maxTokensPerRun || cost > agent.budget.maxCostPerRun || (agent.budget.maxTotalTokens !== undefined && this.usage(request.tenantId, agent.id).totalTokens + totalTokens > agent.budget.maxTotalTokens)) {
      this.trace(request.tenantId, agent.id, request.task, 'failed', `Agent ${agent.id} exceeded its budget on ${request.task}`, undefined, { totalTokens, cost });
      throw new DomainError('BUDGET_EXHAUSTED', 'Agent run exceeded its token or cost budget', { agentId: agent.id, totalTokens, cost });
    }
    const gated = result.proposedAction !== undefined && isGatedAction(result.proposedAction.kind);
    const run: AgentRun = deepFreeze({
      id: this.ids.next('run') as RunId,
      tenantId: request.tenantId,
      agentId: agent.id,
      task: request.task,
      status: gated ? 'pending_approval' : 'completed',
      output: cloneJson(result.output),
      proposedAction: result.proposedAction,
      executed: false,
      inputTokens,
      outputTokens,
      totalTokens,
      cost,
      createdAt: this.clock.now().toISOString(),
    });
    this.runs.set(run.id, run);
    this.trace(request.tenantId, agent.id, request.task, 'succeeded', gated ? `Agent ${agent.id} proposed ${result.proposedAction?.kind} on ${request.task}; awaiting human approval` : `Agent ${agent.id} completed ${request.task}`, run, { status: run.status, totalTokens, cost, proposedAction: result.proposedAction?.kind ?? 'none' });
    return run;
  }

  approve(runId: RunId, tenantId: TenantId, approverId: string): AgentRun {
    const run = this.requireRun(runId, tenantId);
    if (run.status !== 'pending_approval' || !run.proposedAction) {
      throw new DomainError('CONFLICT', 'Run is not pending approval', { runId, status: run.status });
    }
    const executionResult = this.executor ? this.executor.execute(run.proposedAction, tenantId) : `executed:${run.proposedAction.kind}`;
    const approved: AgentRun = deepFreeze({ ...run, status: 'approved', executed: true, executionResult, decidedAt: this.clock.now().toISOString(), decidedBy: approverId });
    this.runs.set(runId, approved);
    this.audit?.append({ tenantId, actor: { kind: 'user', id: approverId }, action: 'agent.approve', subjectType: 'agent_run', subjectId: runId, outcome: 'succeeded', summary: `Approved ${run.proposedAction.kind} from agent ${run.agentId}`, metadata: { runId, agentId: run.agentId, proposedAction: run.proposedAction.kind } });
    return approved;
  }

  reject(runId: RunId, tenantId: TenantId, approverId: string): AgentRun {
    const run = this.requireRun(runId, tenantId);
    if (run.status !== 'pending_approval') {
      throw new DomainError('CONFLICT', 'Run is not pending approval', { runId, status: run.status });
    }
    const rejected: AgentRun = deepFreeze({ ...run, status: 'rejected', executed: false, decidedAt: this.clock.now().toISOString(), decidedBy: approverId });
    this.runs.set(runId, rejected);
    this.audit?.append({ tenantId, actor: { kind: 'user', id: approverId }, action: 'agent.reject', subjectType: 'agent_run', subjectId: runId, outcome: 'succeeded', summary: `Rejected ${run.proposedAction?.kind} from agent ${run.agentId}`, metadata: { runId, agentId: run.agentId, proposedAction: run.proposedAction?.kind ?? 'none' } });
    return rejected;
  }

  getRun(runId: RunId, tenantId: TenantId): AgentRun {
    return this.requireRun(runId, tenantId);
  }

  listRuns(tenantId: TenantId, agentId?: string): readonly AgentRun[] {
    return [...this.runs.values()].filter((run) => run.tenantId === tenantId && (agentId === undefined || run.agentId === agentId)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  usage(tenantId: TenantId, agentId?: string): AgentUsage {
    const runs = this.listRuns(tenantId, agentId);
    return { runs: runs.length, totalTokens: runs.reduce((sum, run) => sum + run.totalTokens, 0), totalCost: round(runs.reduce((sum, run) => sum + run.cost, 0), 6) };
  }

  private requireRun(runId: RunId, tenantId: TenantId): AgentRun {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId) throw new DomainError('NOT_FOUND', 'Agent run not found', { runId });
    return run;
  }

  private trace(tenantId: TenantId, agentId: string, task: string, outcome: 'succeeded' | 'denied' | 'failed', summary: string, run: AgentRun | undefined, metadata: Record<string, unknown>): void {
    this.audit?.append({ tenantId, actor: { kind: 'agent', id: agentId }, action: `agent.run.${task}`, subjectType: 'agent_run', subjectId: run?.id ?? agentId, outcome, summary, metadata: { agentId, task, ...metadata } });
  }
}
