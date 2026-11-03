import { DomainError } from '../core/errors.js';
import type { TenantId, TicketId } from '../core/ids.js';
import type { Ticket, TicketStatus } from './types.js';
import { isOpenStatus } from './types.js';

function key(tenantId: TenantId, ticketId: TicketId): string {
  return `${tenantId}:${ticketId}`;
}

/**
 * Materialized ticket store. Version checks make every write optimistic and
 * keep the aggregate in lockstep with the event stream.
 */
export class TicketRepository {
  private readonly tickets = new Map<string, Ticket>();
  private readonly numbers = new Map<string, number>();

  save(ticket: Ticket, expectedVersion: number): Ticket {
    const existing = this.tickets.get(key(ticket.tenantId, ticket.id));
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new DomainError('CONFLICT', 'Ticket was modified concurrently', {
        ticketId: ticket.id,
        expectedVersion,
        actualVersion: currentVersion,
      });
    }
    this.tickets.set(key(ticket.tenantId, ticket.id), ticket);
    const number = this.numbers.get(ticket.tenantId) ?? 0;
    if (ticket.number > number) this.numbers.set(ticket.tenantId, ticket.number);
    return ticket;
  }

  nextNumber(tenantId: TenantId): number {
    const next = (this.numbers.get(tenantId) ?? 1000) + 1;
    this.numbers.set(tenantId, next);
    return next;
  }

  get(tenantId: TenantId, ticketId: TicketId): Ticket | undefined {
    return this.tickets.get(key(tenantId, ticketId));
  }

  require(tenantId: TenantId, ticketId: TicketId): Ticket {
    const ticket = this.get(tenantId, ticketId);
    if (!ticket) throw new DomainError('NOT_FOUND', 'Ticket not found', { ticketId, tenantId });
    return ticket;
  }

  list(tenantId: TenantId): readonly Ticket[] {
    return [...this.tickets.values()].filter((ticket) => ticket.tenantId === tenantId);
  }

  listAll(): readonly Ticket[] {
    return [...this.tickets.values()];
  }

  tenantIds(): readonly TenantId[] {
    return [...new Set([...this.tickets.values()].map((ticket) => ticket.tenantId))];
  }

  countOpenByAssignee(tenantId: TenantId): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const ticket of this.list(tenantId)) {
      if (!ticket.assigneeId || !isOpenStatus(ticket.status)) continue;
      counts.set(ticket.assigneeId, (counts.get(ticket.assigneeId) ?? 0) + 1);
    }
    return counts;
  }

  countOpenByTeam(tenantId: TenantId): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const ticket of this.list(tenantId)) {
      if (!ticket.teamId || !isOpenStatus(ticket.status)) continue;
      counts.set(ticket.teamId, (counts.get(ticket.teamId) ?? 0) + 1);
    }
    return counts;
  }

  byStatus(tenantId: TenantId, status: TicketStatus): readonly Ticket[] {
    return this.list(tenantId).filter((ticket) => ticket.status === status);
  }

  size(): number {
    return this.tickets.size;
  }
}
