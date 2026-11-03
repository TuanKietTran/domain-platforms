import type { Clock } from '../core/clock.js';
import type { Actor, DomainEvent, EventBus, EventStore } from '../core/events.js';
import { DomainError } from '../core/errors.js';
import { fingerprint, type IdempotencyStore } from '../core/idempotency.js';
import type { AuditLog } from '../core/audit.js';
import type { CustomerId, IdGenerator, TenantId, TicketId, UserId } from '../core/ids.js';
import { authorize, assertTenant, type Principal } from '../core/tenancy.js';
import { deepFreeze } from '../core/util.js';
import type { RoutingDecision, RoutingEngine, RoutingRequest } from '../routing/engine.js';
import type { SlaEngine, SlaTracker } from '../sla/engine.js';
import { applyTransition, type TransitionRequest } from './state-machine.js';
import { TicketRepository } from './repository.js';
import type {
  CreateTicketInput,
  MessageAuthorKind,
  MessageVisibility,
  Ticket,
  TicketAction,
  TicketChannel,
  TicketMessage,
  TicketPriority,
} from './types.js';
import { isOpenStatus } from './types.js';

export const TICKET_EVENTS = {
  created: 'ticket.created',
  routed: 'ticket.routed',
  assigned: 'ticket.assigned',
  transitioned: 'ticket.transitioned',
  messageAdded: 'ticket.message_added',
  updated: 'ticket.updated',
  slaPaused: 'ticket.sla_paused',
  slaResumed: 'ticket.sla_resumed',
  slaMet: 'ticket.sla_met',
  slaBreached: 'ticket.sla_breached',
  reconstructed: 'ticket.reconstructed',
} as const;

export interface TicketServiceDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventStore;
  readonly bus: EventBus;
  readonly audit: AuditLog;
  readonly idempotency: IdempotencyStore;
  readonly sla: SlaEngine;
  readonly routing: RoutingEngine;
}

export interface AddMessageInput {
  readonly body: string;
  readonly visibility: MessageVisibility;
  readonly channel: TicketChannel;
  readonly authorKind: MessageAuthorKind;
  readonly authorId: string;
  readonly citations?: readonly { articleId: string; version: number }[];
  readonly idempotencyKey?: string;
}

export interface AssignInput {
  readonly assigneeId?: UserId;
  readonly teamId?: Ticket['teamId'];
  readonly reason?: string;
}

export interface UpdateTicketInput {
  readonly priority?: TicketPriority;
  readonly tags?: readonly string[];
  readonly language?: string;
  readonly productId?: string;
  readonly customFields?: Readonly<Record<string, string | number | boolean>>;
}

export interface TicketFilter {
  readonly status?: readonly Ticket['status'][];
  readonly assigneeId?: UserId;
  readonly teamId?: Ticket['teamId'];
  readonly priority?: TicketPriority;
  readonly requesterId?: CustomerId;
  readonly tag?: string;
  readonly search?: string;
  readonly limit?: number;
}

export interface SlaSweepResult {
  readonly checked: number;
  readonly breached: readonly { ticketId: TicketId; kind: string; dueAt: string }[];
}

export interface Reconstruction {
  readonly ticket: Ticket;
  readonly timeline: readonly {
    sequence: number;
    type: string;
    at: string;
    actor: Actor;
    summary: string;
  }[];
  readonly consistent: boolean;
}

function actorFor(principal: Principal): Actor {
  return { kind: principal.roles.includes('system') ? 'system' : 'user', id: principal.userId };
}

/**
 * Application service for the ticket aggregate. It is the only place that
 * mutates tickets: it authorizes, validates, applies the state machine, keeps
 * SLA state, appends immutable events and writes the audit trail.
 */
export class TicketService {
  readonly repository = new TicketRepository();

  constructor(private readonly deps: TicketServiceDeps) {}

  private now(): string {
    return this.deps.clock.now().toISOString();
  }

  private append(ticket: Ticket, type: string, actor: Actor, payload: Record<string, unknown>, expectedVersion: number): DomainEvent {
    const event = this.deps.events.append({
      type,
      tenantId: ticket.tenantId,
      aggregateType: 'ticket',
      aggregateId: ticket.id,
      expectedVersion,
      actor,
      payload: { ticket, ...payload },
    });
    void this.deps.bus.publish(event);
    return event;
  }

  private audit(
    ticket: Ticket,
    actor: Actor,
    action: string,
    outcome: 'succeeded' | 'failed' | 'denied',
    summary: string,
    metadata: Record<string, unknown> = {},
  ): void {
    this.deps.audit.append({
      tenantId: ticket.tenantId,
      actor: { kind: actor.kind, id: actor.id },
      action,
      subjectType: 'ticket',
      subjectId: ticket.id,
      outcome,
      summary,
      metadata,
    });
  }

  private resolveSla(ticket: Ticket): { ticket: Ticket; tracker?: SlaTracker } {
    const policy = this.deps.sla.selectPolicy(ticket.tenantId, ticket.priority);
    return { ticket, tracker: this.deps.sla.createTracker(policy, ticket.priority, ticket.createdAt) };
  }

  async createTicket(
    principal: Principal,
    input: CreateTicketInput,
    actor: Actor = actorFor(principal),
  ): Promise<Ticket> {
    authorize(principal, 'ticket:create', input.tenantId);
    assertTenant(principal, input.tenantId);
    const subject = input.subject.trim();
    const description = input.description.trim();
    if (subject.length < 3) throw new DomainError('VALIDATION', 'Ticket subject is too short', { subject });
    if (description.length < 1) throw new DomainError('VALIDATION', 'Ticket description is required');

    const requestFingerprint = fingerprint({
      tenantId: input.tenantId,
      subject,
      description,
      requesterId: input.requesterId,
      channel: input.channel,
    });

    return this.deps.idempotency.run(
      { tenantId: input.tenantId, key: input.idempotencyKey, fingerprint: requestFingerprint },
      async () => {
        const at = this.now();
        const id = this.deps.ids.next('tkt') as TicketId;
        const base: Ticket = deepFreeze({
          id,
          tenantId: input.tenantId,
          number: this.repository.nextNumber(input.tenantId),
          subject,
          description,
          status: 'new' as const,
          priority: input.priority ?? 'normal',
          channel: input.channel,
          requesterId: input.requesterId,
          tags: [...(input.tags ?? [])],
          language: input.language ?? 'en',
          productId: input.productId,
          createdAt: at,
          updatedAt: at,
          reopenCount: 0,
          version: 1,
          transitions: [],
          customFields: { ...(input.customFields ?? {}) },
        });

        const routingRequest: RoutingRequest = {
          tenantId: input.tenantId,
          channel: base.channel,
          priority: base.priority,
          tags: base.tags,
          subject: base.subject,
          description: base.description,
          language: base.language,
          productId: base.productId,
        };
        const routing = this.deps.routing.decide(routingRequest, {
          load: this.repository.countOpenByAssignee(input.tenantId),
        });

        const sla = this.tryTracker(base);
        const ticket: Ticket = deepFreeze({
          ...base,
          priority: routing.priority,
          tags: routing.tags,
          teamId: routing.teamId,
          assigneeId: routing.assigneeId,
          sla,
          version: 2,
        });

        this.repository.save(ticket, 0);
        this.append(ticket, TICKET_EVENTS.created, actor, { routing, slaPolicyId: sla?.policyId }, 0);
        this.audit(ticket, actor, 'ticket.create', 'succeeded', `Ticket #${ticket.number} created via ${ticket.channel}`, {
          routingRuleIds: routing.matchedRules.map((rule) => rule.ruleId),
          assignedTeam: routing.teamId,
          assignedAgent: routing.assigneeId,
          priority: ticket.priority,
        });
        return ticket;
      },
    );
  }

  private tryTracker(ticket: Ticket): SlaTracker | undefined {
    try {
      return this.deps.sla.createTracker(
        this.deps.sla.selectPolicy(ticket.tenantId, ticket.priority),
        ticket.priority,
        ticket.createdAt,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  get(principal: Principal, ticketId: TicketId): Ticket {
    authorize(principal, 'ticket:read');
    const ticket = this.repository.require(principal.tenantId, ticketId);
    if (principal.roles.includes('requester') && ticket.requesterId !== (principal.userId as unknown as CustomerId)) {
      throw new DomainError('FORBIDDEN', 'Requesters may only read their own tickets', { ticketId });
    }
    return ticket;
  }

  list(principal: Principal, filter: TicketFilter = {}): readonly Ticket[] {
    authorize(principal, 'ticket:read');
    let tickets = [...this.repository.list(principal.tenantId)];
    if (principal.roles.includes('requester') && !principal.roles.includes('agent')) {
      tickets = tickets.filter((ticket) => ticket.requesterId === (principal.userId as unknown as CustomerId));
    }
    if (filter.status?.length) tickets = tickets.filter((ticket) => filter.status?.includes(ticket.status));
    if (filter.assigneeId) tickets = tickets.filter((ticket) => ticket.assigneeId === filter.assigneeId);
    if (filter.teamId) tickets = tickets.filter((ticket) => ticket.teamId === filter.teamId);
    if (filter.priority) tickets = tickets.filter((ticket) => ticket.priority === filter.priority);
    if (filter.requesterId) tickets = tickets.filter((ticket) => ticket.requesterId === filter.requesterId);
    if (filter.tag) tickets = tickets.filter((ticket) => ticket.tags.includes(filter.tag as string));
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      tickets = tickets.filter(
        (ticket) =>
          ticket.subject.toLowerCase().includes(needle) ||
          ticket.description.toLowerCase().includes(needle),
      );
    }
    tickets.sort((a, b) => b.number - a.number);
    return filter.limit ? tickets.slice(0, filter.limit) : tickets;
  }

  assign(principal: Principal, ticketId: TicketId, input: AssignInput, actor: Actor = actorFor(principal)): Ticket {
    authorize(principal, 'ticket:assign');
    const ticket = this.repository.require(principal.tenantId, ticketId);
    if (!isOpenStatus(ticket.status)) {
      throw new DomainError('TRANSITION_NOT_ALLOWED', 'Closed tickets cannot be reassigned', {
        ticketId,
        status: ticket.status,
      });
    }
    if (!input.assigneeId && !input.teamId) {
      throw new DomainError('VALIDATION', 'Assignment requires an assignee or a team');
    }
    const at = this.now();
    const next: Ticket = deepFreeze({
      ...ticket,
      assigneeId: input.assigneeId ?? ticket.assigneeId,
      teamId: input.teamId ?? ticket.teamId,
      updatedAt: at,
      version: ticket.version + 1,
    });
    this.repository.save(next, ticket.version);
    this.append(next, TICKET_EVENTS.assigned, actor, {
      assigneeId: next.assigneeId,
      teamId: next.teamId,
      reason: input.reason,
    }, ticket.version);
    this.audit(next, actor, 'ticket.assign', 'succeeded', `Ticket #${next.number} assigned`, {
      assigneeId: next.assigneeId,
      teamId: next.teamId,
      reason: input.reason,
    });
    return next;
  }

  update(principal: Principal, ticketId: TicketId, input: UpdateTicketInput, actor: Actor = actorFor(principal)): Ticket {
    authorize(principal, 'ticket:update');
    const ticket = this.repository.require(principal.tenantId, ticketId);
    if (ticket.status === 'closed') {
      throw new DomainError('TRANSITION_NOT_ALLOWED', 'Closed tickets cannot be edited', { ticketId });
    }
    const at = this.now();
    const next: Ticket = deepFreeze({
      ...ticket,
      priority: input.priority ?? ticket.priority,
      tags: input.tags ? [...input.tags] : ticket.tags,
      language: input.language ?? ticket.language,
      productId: input.productId ?? ticket.productId,
      customFields: input.customFields ? { ...ticket.customFields, ...input.customFields } : ticket.customFields,
      updatedAt: at,
      version: ticket.version + 1,
    });
    this.repository.save(next, ticket.version);
    this.append(next, TICKET_EVENTS.updated, actor, { changes: input }, ticket.version);
    this.audit(next, actor, 'ticket.update', 'succeeded', `Ticket #${next.number} updated`, {
      changes: input,
    });
    return next;
  }

  transition(
    principal: Principal,
    ticketId: TicketId,
    action: TicketAction,
    options: { reason?: string; resolutionSummary?: string; assigneeId?: UserId; teamId?: Ticket['teamId'] } = {},
    actor: Actor = actorFor(principal),
  ): Ticket {
    const ticket = this.repository.require(principal.tenantId, ticketId);
    const request: TransitionRequest = {
      action,
      at: this.now(),
      actorId: actor.id,
      reason: options.reason,
      resolutionSummary: options.resolutionSummary,
      assigneeId: options.assigneeId,
      teamId: options.teamId,
    };
    const definition = applyTransition(ticket, request).definition;
    authorize(principal, definition.permission, ticket.tenantId);

    let result = applyTransition(ticket, request);
    let next = result.ticket;

    if (next.sla) {
      if (action === 'request_customer_info') {
        next = deepFreeze({ ...next, sla: this.deps.sla.pause(next.sla, request.at, 'waiting_for_customer') });
      } else if (action === 'resume' && next.sla.pausedAt) {
        next = deepFreeze({ ...next, sla: this.deps.sla.resume(next.sla, request.at) });
      } else if (action === 'resolve') {
        const due = next.sla.targets.find((target) => target.kind === 'resolution');
        if (due && new Date(due.dueAt).getTime() >= new Date(request.at).getTime()) {
          next = deepFreeze({ ...next, sla: this.deps.sla.markMet(next.sla, 'resolution', request.at) });
        } else if (due) {
          next = deepFreeze({ ...next, sla: this.deps.sla.recordBreach(next.sla, 'resolution', request.at) });
        }
      }
    }

    result = { ...result, ticket: next };
    this.repository.save(next, ticket.version);
    this.append(next, TICKET_EVENTS.transitioned, actor, {
      action,
      from: result.from,
      to: result.to,
      reason: options.reason,
      resolutionSummary: options.resolutionSummary,
    }, ticket.version);
    this.audit(next, actor, `ticket.${action}`, 'succeeded', `Ticket #${next.number}: ${result.from} -> ${result.to}`, {
      action,
      from: result.from,
      to: result.to,
      reason: options.reason,
    });
    return next;
  }

  addMessage(
    principal: Principal,
    ticketId: TicketId,
    input: AddMessageInput,
    actor: Actor = actorFor(principal),
  ): { ticket: Ticket; message: TicketMessage } {
    authorize(principal, input.visibility === 'internal' ? 'ticket:note' : 'ticket:message');
    const ticket = this.repository.require(principal.tenantId, ticketId);
    if (ticket.status === 'closed') {
      throw new DomainError('TRANSITION_NOT_ALLOWED', 'Closed tickets cannot receive messages', { ticketId });
    }
    const body = input.body.trim();
    if (body.length === 0) throw new DomainError('VALIDATION', 'Message body is required');
    const at = this.now();
    const message: TicketMessage = deepFreeze({
      id: this.deps.ids.next('msg'),
      ticketId,
      tenantId: ticket.tenantId,
      authorKind: input.authorKind,
      authorId: input.authorId,
      visibility: input.visibility,
      body,
      createdAt: at,
      channel: input.channel,
      citations: input.citations,
    });

    let sla = ticket.sla;
    let firstResponseAt = ticket.firstResponseAt;
    let lastAgentMessageAt = ticket.lastAgentMessageAt;
    let lastCustomerMessageAt = ticket.lastCustomerMessageAt;

    if (input.visibility === 'public' && input.authorKind === 'customer') {
      lastCustomerMessageAt = at;
      if (sla && firstResponseAt && sla.targets.some((target) => target.kind === 'next_response')) {
        sla = this.deps.sla.reopenTarget(sla, 'next_response', at);
      }
    }
    if (input.visibility === 'public' && (input.authorKind === 'agent' || input.authorKind === 'agent_assistant')) {
      lastAgentMessageAt = at;
      if (!firstResponseAt) {
        firstResponseAt = at;
        if (sla) sla = this.deps.sla.markMet(sla, 'first_response', at);
      }
      if (sla && sla.targets.some((target) => target.kind === 'next_response')) {
        sla = this.deps.sla.markMet(sla, 'next_response', at);
      }
    }

    const next: Ticket = deepFreeze({
      ...ticket,
      firstResponseAt,
      lastAgentMessageAt,
      lastCustomerMessageAt,
      sla,
      updatedAt: at,
      version: ticket.version + 1,
    });
    this.repository.save(next, ticket.version);
    this.append(next, TICKET_EVENTS.messageAdded, actor, {
      messageId: message.id,
      visibility: message.visibility,
      authorKind: message.authorKind,
      citations: message.citations ?? [],
    }, ticket.version);
    this.audit(next, actor, input.visibility === 'internal' ? 'ticket.note' : 'ticket.message', 'succeeded', `${input.visibility} message on ticket #${next.number}`, {
      messageId: message.id,
      authorKind: message.authorKind,
      citations: message.citations ?? [],
    });
    return { ticket: next, message };
  }

  /** Finds tickets whose SLA deadlines have passed and records the breach once. */
  sweepSla(at: string = this.now()): SlaSweepResult {
    const breached: { ticketId: TicketId; kind: string; dueAt: string }[] = [];
    let checked = 0;
    for (const tenantId of this.tenants()) {
      for (const ticket of this.repository.list(tenantId)) {
        checked += 1;
        if (!ticket.sla || !isOpenStatus(ticket.status)) continue;
        const found = this.deps.sla.breaches(ticket.sla, at);
        if (found.length === 0) continue;
        let sla = ticket.sla;
        for (const breach of found) sla = this.deps.sla.recordBreach(sla, breach.kind, at);
        const next: Ticket = deepFreeze({ ...ticket, sla, updatedAt: at, version: ticket.version + 1 });
        this.repository.save(next, ticket.version);
        const actor: Actor = { kind: 'system', id: 'sla-engine' };
        this.append(next, TICKET_EVENTS.slaBreached, actor, { breaches: found }, ticket.version);
        this.audit(next, actor, 'ticket.sla.breach', 'succeeded', `SLA breached on ticket #${next.number}`, {
          breaches: found,
        });
        for (const breach of found) breached.push({ ticketId: ticket.id, kind: breach.kind, dueAt: breach.dueAt });
      }
    }
    return { checked, breached };
  }

  private tenants(): TenantId[] {
    return [...this.repository.tenantIds()];
  }

  /** Rebuilds a ticket from its event stream and verifies version continuity. */
  reconstruct(principal: Principal, ticketId: TicketId): Reconstruction {
    authorize(principal, 'audit:read');
    const events = this.deps.events.readAggregate(principal.tenantId, 'ticket', ticketId);
    if (events.length === 0) throw new DomainError('NOT_FOUND', 'No events for ticket', { ticketId });
    let expected = 1;
    let consistent = true;
    let ticket: Ticket | undefined;
    const timeline: Reconstruction['timeline'][number][] = [];
    for (const event of events) {
      if (event.aggregateVersion !== expected) consistent = false;
      expected = event.aggregateVersion + 1;
      const payload = event.payload as { ticket?: Ticket };
      if (payload.ticket) ticket = payload.ticket;
      timeline.push({
        sequence: event.sequence,
        type: event.type,
        at: event.occurredAt,
        actor: event.actor,
        summary: `${event.type} v${event.aggregateVersion}`,
      });
    }
    if (!ticket) throw new DomainError('INTEGRITY_FAILURE', 'Event stream has no ticket snapshot', { ticketId });
    return { ticket, timeline, consistent };
  }
}
