import { DomainError } from '../core/errors.js';
import type { Permission } from '../identity/permissions.js';

/**
 * A declarative workflow state machine.
 *
 * States, transitions, guards and the permission each transition requires are
 * data, not code paths. Adding a new state or approval route is therefore a
 * configuration change, and every attempt to move a record is explainable: the
 * machine either finds a transition whose guard passes, or reports precisely
 * why the move was refused.
 */
export type GuardVerdict = boolean | { readonly ok: boolean; readonly reason: string };

export interface TransitionContext {
  readonly facts: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly actorId: string;
  readonly permitted: (permission: Permission, transition: WorkflowTransition<string>) => boolean;
}

export interface WorkflowTransition<S extends string> {
  readonly action: string;
  readonly from: S;
  readonly to: S;
  readonly label: string;
  readonly permission?: Permission;
  readonly guard?: (ctx: TransitionContext) => GuardVerdict;
  /** Emitted verb when the transition succeeds, e.g. "expense_report.approved". */
  readonly event: string;
}

export interface WorkflowState<S extends string> {
  readonly state: S;
  readonly label: string;
  readonly terminal: boolean;
}

export interface WorkflowDefinition<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly WorkflowState<S>[];
  readonly transitions: readonly WorkflowTransition<S>[];
}

export interface WorkflowInstance<S extends string> {
  readonly workflowId: string;
  readonly tenantId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly state: S;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitionedBy: string;
}

export interface WorkflowMove<S extends string> {
  readonly instance: WorkflowInstance<S>;
  readonly transition: WorkflowTransition<S>;
  readonly from: S;
  readonly to: S;
  readonly at: string;
}

export function defineWorkflow<S extends string>(definition: WorkflowDefinition<S>): WorkflowDefinition<S> {
  const states = new Set(definition.states.map((state) => state.state));
  if (!states.has(definition.initial)) {
    throw new DomainError('STATE_INVALID', 'Initial state is not declared', { initial: definition.initial });
  }
  for (const transition of definition.transitions) {
    if (!states.has(transition.from) || !states.has(transition.to)) {
      throw new DomainError('STATE_INVALID', 'Transition references an undeclared state', {
        action: transition.action,
        from: transition.from,
        to: transition.to,
      });
    }
  }
  return Object.freeze(definition);
}

export class WorkflowMachine<S extends string> {
  constructor(readonly definition: WorkflowDefinition<S>) {}

  stateLabel(state: S): string {
    return this.definition.states.find((entry) => entry.state === state)?.label ?? state;
  }

  isTerminal(state: S): boolean {
    return this.definition.states.find((entry) => entry.state === state)?.terminal ?? false;
  }

  transitionsFrom(state: S): readonly WorkflowTransition<S>[] {
    return this.definition.transitions.filter((transition) => transition.from === state);
  }

  find(from: S, action: string): WorkflowTransition<S> | undefined {
    return this.definition.transitions.find((transition) => transition.from === from && transition.action === action);
  }

  /** Actions that are currently legal for the given facts and actor. */
  available(state: S, ctx: TransitionContext): readonly WorkflowTransition<S>[] {
    return this.transitionsFrom(state).filter((transition) => {
      if (transition.permission && !ctx.permitted(transition.permission, transition)) return false;
      if (!transition.guard) return true;
      const verdict = transition.guard(ctx);
      return typeof verdict === 'boolean' ? verdict : verdict.ok;
    });
  }

  /**
   * Apply an action, returning the new instance and the movement record.
   * Refusals carry the reason from the guard so an operator can see it.
   */
  apply(
    instance: WorkflowInstance<S>,
    action: string,
    ctx: TransitionContext,
    now: Date,
    nextVersion?: number,
  ): WorkflowMove<S> {
    const transition = this.find(instance.state, action);
    if (!transition) {
      throw new DomainError('STATE_INVALID', `Action "${action}" is not available from "${instance.state}"`, {
        state: instance.state,
        action,
        available: this.transitionsFrom(instance.state).map((entry) => entry.action),
      });
    }
    if (this.isTerminal(instance.state)) {
      throw new DomainError('STATE_INVALID', `State "${instance.state}" is terminal`, { state: instance.state });
    }
    if (transition.permission && !ctx.permitted(transition.permission, transition)) {
      throw new DomainError('FORBIDDEN', `Transition "${action}" requires ${transition.permission}`, {
        action,
        permission: transition.permission,
      });
    }
    if (transition.guard) {
      const verdict = transition.guard(ctx);
      const ok = typeof verdict === 'boolean' ? verdict : verdict.ok;
      if (!ok) {
        throw new DomainError('APPROVAL_REQUIRED', `Guard refused transition "${action}"`, {
          action,
          reason: typeof verdict === 'boolean' ? 'guard returned false' : verdict.reason,
        });
      }
    }
    const at = now.toISOString();
    return Object.freeze({
      instance: Object.freeze({
        ...instance,
        state: transition.to,
        version: nextVersion ?? instance.version + 1,
        updatedAt: at,
        transitionedBy: ctx.actorId,
      }),
      transition,
      from: instance.state,
      to: transition.to,
      at,
    });
  }
}

export interface StoredWorkflow {
  readonly instance: WorkflowInstance<string>;
  readonly movements: readonly WorkflowMove<string>[];
}

/** Append-only workflow store with optimistic concurrency on the version. */
export class WorkflowStore {
  private readonly records = new Map<string, StoredWorkflow>();

  private key(tenantId: string, workflowId: string): string {
    return `${tenantId}:${workflowId}`;
  }

  create(instance: WorkflowInstance<string>): void {
    const key = this.key(instance.tenantId, instance.workflowId);
    if (this.records.has(key)) {
      throw new DomainError('CONFLICT', 'Workflow instance already exists', { workflowId: instance.workflowId });
    }
    this.records.set(key, Object.freeze({ instance, movements: Object.freeze([]) }));
  }

  get(tenantId: string, workflowId: string): StoredWorkflow | undefined {
    return this.records.get(this.key(tenantId, workflowId));
  }

  require(tenantId: string, workflowId: string): StoredWorkflow {
    const record = this.get(tenantId, workflowId);
    if (!record) throw new DomainError('NOT_FOUND', 'Workflow instance not found', { workflowId });
    return record;
  }

  /** Persist a movement, rejecting stale writers. */
  save(move: WorkflowMove<string>, expectedVersion: number): StoredWorkflow {
    const record = this.require(move.instance.tenantId, move.instance.workflowId);
    if (record.instance.version !== expectedVersion) {
      throw new DomainError('CONFLICT', 'Workflow was modified concurrently', {
        expectedVersion,
        actualVersion: record.instance.version,
      });
    }
    const updated: StoredWorkflow = Object.freeze({
      instance: move.instance,
      movements: Object.freeze([...record.movements, move]),
    });
    this.records.set(this.key(move.instance.tenantId, move.instance.workflowId), updated);
    return updated;
  }

  bySubject(tenantId: string, subjectType: string, subjectId: string): StoredWorkflow | undefined {
    return [...this.records.values()].find(
      (record) =>
        record.instance.tenantId === tenantId &&
        record.instance.subjectType === subjectType &&
        record.instance.subjectId === subjectId,
    );
  }

  list(tenantId: string, state?: string): readonly StoredWorkflow[] {
    return [...this.records.values()].filter(
      (record) => record.instance.tenantId === tenantId && (!state || record.instance.state === state),
    );
  }
}
