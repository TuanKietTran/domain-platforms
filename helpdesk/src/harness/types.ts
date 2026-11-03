import type { RunId, TenantId } from '../core/ids.js';

export type AgentPermission =
  | 'ticket:classify'
  | 'ticket:draft_reply'
  | 'ticket:summarize'
  | 'ticket:analyze'
  | 'ticket:resolve'
  | 'ticket:close'
  | 'ticket:escalate';

export type ActionKind =
  | 'none'
  | 'classify'
  | 'suggest_reply'
  | 'summarize'
  | 'analyze_sentiment'
  | 'resolve_ticket'
  | 'close_ticket'
  | 'escalate_ticket';

/** Actions an AI may propose but never execute on its own. Enforced by the harness for every agent, regardless of the agent's own configuration. */
export const GATED_ACTIONS: readonly ActionKind[] = ['resolve_ticket', 'close_ticket', 'escalate_ticket'];

export function isGatedAction(kind: ActionKind): boolean {
  return GATED_ACTIONS.includes(kind);
}

export interface ProposedAction {
  readonly kind: ActionKind;
  readonly ticketId?: string;
  readonly summary: string;
}

export interface AgentBudget {
  readonly maxTokensPerRun: number;
  readonly maxCostPerRun: number;
  readonly maxTotalTokens?: number;
}

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly AgentPermission[];
  readonly budget: AgentBudget;
  readonly costPerThousandTokens: number;
}

export interface ModelRequest {
  readonly task: string;
  readonly prompt: string;
  readonly context?: Readonly<Record<string, string>>;
}

export interface ModelResponse {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface Model {
  generate(request: ModelRequest): ModelResponse;
}

export type AgentRunStatus = 'completed' | 'pending_approval' | 'approved' | 'rejected';

export interface AgentRun {
  readonly id: RunId;
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly task: string;
  readonly status: AgentRunStatus;
  readonly output?: unknown;
  readonly proposedAction?: ProposedAction;
  readonly executed: boolean;
  readonly executionResult?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

export interface AgentWorkResult<T> {
  readonly output: T;
  readonly proposedAction?: ProposedAction;
}

export interface RunAgentRequest<T> {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly task: string;
  readonly permission: AgentPermission;
  readonly execute: (model: Model) => AgentWorkResult<T>;
}

/** Port for applying an approved action to the outside world (e.g. the ticket service). Called exactly once, and only from approve(). */
export interface ActionExecutor {
  execute(action: ProposedAction, tenantId: TenantId): string;
}

export interface AgentUsage {
  readonly runs: number;
  readonly totalTokens: number;
  readonly totalCost: number;
}
