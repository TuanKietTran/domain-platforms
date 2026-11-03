import { DomainError } from '../core/errors.js';
import type { Permission } from '../core/tenancy.js';
import { deepFreeze } from '../core/util.js';
import type { Ticket, TicketAction, TicketStatus } from './types.js';

export interface TransitionDefinition {
  readonly action: TicketAction;
  readonly from: readonly TicketStatus[];
  readonly to: TicketStatus;
  readonly permission: Permission;
  readonly label: string;
  readonly requiresAssignee: boolean;
  readonly requiresResolutionSummary: boolean;
}

/**
 * The single source of truth for ticket lifecycle. Every status change in the
 * platform goes through here, so history, guards and permissions cannot drift
 * between features.
 */
export const TRANSITIONS: readonly TransitionDefinition[] = deepFreeze([
  {
    action: 'triage',
    from: ['new'],
    to: 'triaged',
    permission: 'ticket:transition',
    label: 'Triage ticket',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'start',
    from: ['triaged'],
    to: 'in_progress',
    permission: 'ticket:transition',
    label: 'Start work',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'request_customer_info',
    from: ['triaged', 'in_progress', 'pending_third_party'],
    to: 'pending_customer',
    permission: 'ticket:transition',
    label: 'Wait for customer',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'request_third_party',
    from: ['triaged', 'in_progress', 'pending_customer'],
    to: 'pending_third_party',
    permission: 'ticket:transition',
    label: 'Wait for third party',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'resume',
    from: ['pending_customer', 'pending_third_party'],
    to: 'in_progress',
    permission: 'ticket:transition',
    label: 'Resume work',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'resolve',
    from: ['triaged', 'in_progress', 'pending_customer', 'pending_third_party'],
    to: 'resolved',
    permission: 'ticket:transition',
    label: 'Resolve ticket',
    requiresAssignee: false,
    requiresResolutionSummary: true,
  },
  {
    action: 'close',
    from: ['resolved'],
    to: 'closed',
    permission: 'ticket:close',
    label: 'Close ticket',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'cancel',
    from: ['new', 'triaged'],
    to: 'closed',
    permission: 'ticket:close',
    label: 'Cancel ticket',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
  {
    action: 'reopen',
    from: ['resolved', 'closed'],
    to: 'in_progress',
    permission: 'ticket:reopen',
    label: 'Reopen ticket',
    requiresAssignee: false,
    requiresResolutionSummary: false,
  },
] as const);

export function transitionFor(action: TicketAction): TransitionDefinition {
  const definition = TRANSITIONS.find((candidate) => candidate.action === action);
  if (!definition) throw new DomainError('VALIDATION', 'Unknown ticket action', { action });
  return definition;
}

export function availableActions(ticket: Ticket): readonly TransitionDefinition[] {
  return TRANSITIONS.filter((definition) => definition.from.includes(ticket.status));
}

export interface TransitionRequest {
  readonly action: TicketAction;
  readonly at: string;
  readonly actorId: string;
  readonly reason?: string;
  readonly resolutionSummary?: string;
  readonly assigneeId?: Ticket['assigneeId'];
  readonly teamId?: Ticket['teamId'];
}

export interface TransitionResult {
  readonly ticket: Ticket;
  readonly definition: TransitionDefinition;
  readonly from: TicketStatus;
  readonly to: TicketStatus;
  readonly timestamps: {
    readonly resolvedAt?: string;
    readonly closedAt?: string;
    readonly reopened: boolean;
    readonly firstResponseAt?: string;
  };
}

/**
 * Pure transition function. All validation happens before any state is
 * produced, so a rejected transition leaves the aggregate untouched.
 */
export function applyTransition(ticket: Ticket, request: TransitionRequest): TransitionResult {
  if (ticket.status === 'closed' && request.action !== 'reopen') {
    throw new DomainError('TRANSITION_NOT_ALLOWED', 'Closed tickets must be reopened before further changes', {
      ticketId: ticket.id,
      status: ticket.status,
      action: request.action,
    });
  }
  const definition = transitionFor(request.action);
  if (!definition.from.includes(ticket.status)) {
    throw new DomainError('TRANSITION_NOT_ALLOWED', 'Action is not allowed from the current status', {
      ticketId: ticket.id,
      action: request.action,
      status: ticket.status,
      allowedFrom: definition.from,
    });
  }
  const summary = request.resolutionSummary?.trim();
  if (definition.requiresResolutionSummary && !summary) {
    throw new DomainError('VALIDATION', 'A resolution summary is required to resolve a ticket', {
      ticketId: ticket.id,
    });
  }
  if (definition.requiresAssignee && !ticket.assigneeId && !request.assigneeId) {
    throw new DomainError('VALIDATION', 'An assignee is required for this action', {
      ticketId: ticket.id,
    });
  }

  const reopened = request.action === 'reopen';
  const resolvedAt = request.action === 'resolve' ? request.at : reopened ? undefined : ticket.resolvedAt;
  const closedAt = request.action === 'close' || request.action === 'cancel' ? request.at : reopened ? undefined : ticket.closedAt;

  const next: Ticket = deepFreeze({
    ...ticket,
    status: definition.to,
    updatedAt: request.at,
    assigneeId: request.assigneeId ?? ticket.assigneeId,
    teamId: request.teamId ?? ticket.teamId,
    resolvedAt,
    closedAt,
    reopenCount: reopened ? ticket.reopenCount + 1 : ticket.reopenCount,
    resolutionSummary: request.action === 'resolve' ? summary : reopened ? undefined : ticket.resolutionSummary,
    version: ticket.version + 1,
    transitions: [
      ...ticket.transitions,
      {
        action: request.action,
        from: ticket.status,
        to: definition.to,
        at: request.at,
        actorId: request.actorId,
        reason: request.reason,
      },
    ],
  });

  return {
    ticket: next,
    definition,
    from: ticket.status,
    to: definition.to,
    timestamps: {
      resolvedAt,
      closedAt,
      reopened,
      firstResponseAt: ticket.firstResponseAt,
    },
  };
}

export interface StatusDoc {
  readonly status: TicketStatus;
  readonly label: string;
  readonly actions: readonly { action: TicketAction; to: TicketStatus; label: string }[];
}

export function describeLifecycle(): readonly StatusDoc[] {
  const labels: Record<TicketStatus, string> = {
    new: 'New',
    triaged: 'Triaged',
    in_progress: 'In progress',
    pending_customer: 'Pending customer',
    pending_third_party: 'Pending third party',
    resolved: 'Resolved',
    closed: 'Closed',
  };
  const statuses = Object.keys(labels) as TicketStatus[];
  return statuses.map((status) => ({
    status,
    label: labels[status],
    actions: TRANSITIONS.filter((definition) => definition.from.includes(status)).map((definition) => ({
      action: definition.action,
      to: definition.to,
      label: definition.label,
    })),
  }));
}
