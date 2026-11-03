import type { Clock } from './clock.js';
import { DomainError } from './errors.js';
import type { EventId, IdGenerator, TenantId } from './ids.js';
import { deepFreeze } from './util.js';

export type ActorKind = 'user' | 'customer' | 'system' | 'agent' | 'integration';

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly displayName?: string;
}

export interface DomainEvent<T = unknown> {
  readonly id: EventId;
  readonly type: string;
  readonly tenantId: TenantId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actor: Actor;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: Readonly<T>;
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly allHandlers = new Set<EventHandler>();

  subscribe<T>(type: string, handler: EventHandler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);
    return () => set.delete(handler as EventHandler);
  }

  subscribeAll(handler: EventHandler): () => void {
    this.allHandlers.add(handler);
    return () => this.allHandlers.delete(handler);
  }

  async publish(event: DomainEvent): Promise<void> {
    const specific = this.handlers.get(event.type);
    if (specific) {
      for (const handler of specific) await handler(event);
    }
    for (const handler of this.allHandlers) await handler(event);
  }
}

export interface AppendEventInput<T> {
  readonly type: string;
  readonly tenantId: TenantId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly actor: Actor;
  readonly payload: T;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/**
 * Append-only event store with optimistic concurrency per aggregate and a
 * global ordering sequence. It is the substrate for reconstructing tickets.
 */
export class EventStore {
  private readonly events: DomainEvent[] = [];
  private readonly versions = new Map<string, number>();
  private sequence = 0;

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  append<T>(input: AppendEventInput<T>): DomainEvent<T> {
    const key = `${input.tenantId}:${input.aggregateType}:${input.aggregateId}`;
    const current = this.versions.get(key) ?? 0;
    if (input.expectedVersion !== current) {
      throw new DomainError('CONFLICT', 'Concurrent modification detected', {
        aggregateId: input.aggregateId,
        expectedVersion: input.expectedVersion,
        actualVersion: current,
      });
    }
    const version = current + 1;
    this.sequence += 1;
    const event: DomainEvent<T> = deepFreeze({
      id: this.ids.next('evt') as EventId,
      type: input.type,
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      aggregateVersion: version,
      sequence: this.sequence,
      occurredAt: this.clock.now().toISOString(),
      actor: input.actor,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: input.payload,
    });
    this.versions.set(key, version);
    this.events.push(event);
    return event;
  }

  readAggregate(tenantId: TenantId, aggregateType: string, aggregateId: string): readonly DomainEvent[] {
    return this.events.filter(
      (event) =>
        event.tenantId === tenantId &&
        event.aggregateType === aggregateType &&
        event.aggregateId === aggregateId,
    );
  }

  readAll(filter: {
    tenantId?: TenantId;
    type?: string;
    fromSequence?: number;
    limit?: number;
  } = {}): readonly DomainEvent[] {
    let result = this.events.filter((event) => {
      if (filter.tenantId && event.tenantId !== filter.tenantId) return false;
      if (filter.type && event.type !== filter.type) return false;
      if (filter.fromSequence !== undefined && event.sequence <= filter.fromSequence) return false;
      return true;
    });
    if (filter.limit !== undefined) result = result.slice(0, filter.limit);
    return result;
  }

  get size(): number {
    return this.events.length;
  }

  currentVersion(tenantId: TenantId, aggregateType: string, aggregateId: string): number {
    return this.versions.get(`${tenantId}:${aggregateType}:${aggregateId}`) ?? 0;
  }
}
