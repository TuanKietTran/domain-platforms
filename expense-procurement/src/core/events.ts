import type { IsoTimestamp, TenantId, UserId } from './types.js';
import { isoTimestamp } from './types.js';
import { DomainError } from './errors.js';
import { deepFreeze } from './canonical.js';

export type ActorKind = 'user' | 'system' | 'agent';

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly displayName?: string;
  /** Set when an agent acts on behalf of a human principal. */
  readonly onBehalfOf?: UserId;
}

export const SYSTEM_ACTOR: Actor = Object.freeze({ kind: 'system', id: 'system' });

export function userActor(id: UserId, displayName?: string): Actor {
  return Object.freeze({ kind: 'user', id, ...(displayName ? { displayName } : {}) });
}

export function agentActor(id: string, onBehalfOf?: UserId): Actor {
  return Object.freeze({ kind: 'agent', id, ...(onBehalfOf ? { onBehalfOf } : {}) });
}

export interface SubjectRef {
  readonly type: string;
  readonly id: string;
}

export interface DomainEvent<P = unknown> {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: IsoTimestamp;
  readonly recordedAt: IsoTimestamp;
  readonly actor: Actor;
  readonly subject: SubjectRef;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: P;
}

export type EventHandler<P = unknown> = (event: DomainEvent<P>) => void;

export interface PublishableEvent<P = unknown> {
  readonly tenantId: TenantId;
  readonly type: string;
  readonly version?: number;
  readonly occurredAt?: IsoTimestamp;
  readonly actor: Actor;
  readonly subject: SubjectRef;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly payload: P;
}

export interface EventStore {
  append<P>(event: PublishableEvent<P>): DomainEvent<P>;
  read(tenantId: TenantId, afterSequence?: number): readonly StoredEvent[];
  all(): readonly StoredEvent[];
  latestSequence(tenantId: TenantId): number;
}

export interface StoredEvent {
  readonly sequence: number;
  readonly event: DomainEvent;
}

/**
 * Synchronous, ordered event bus. Handlers are isolated: a failing subscriber
 * is reported to the error sink but never breaks the mutation that published
 * the event, because the event store is the source of truth.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(private readonly onHandlerError: (error: unknown, event: DomainEvent) => void = () => {}) {}

  subscribe<P>(type: string, handler: EventHandler<P>): () => void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as EventHandler);
    };
  }

  subscribeAll(handler: EventHandler): () => void {
    return this.subscribe('*', handler);
  }

  publish(event: DomainEvent): void {
    const targets = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of targets) {
      try {
        handler(event);
      } catch (error) {
        this.onHandlerError(error, event);
      }
    }
  }
}

export interface EventStoreOptions {
  readonly bus?: EventBus;
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

/** Append-only in-memory event store with per-tenant monotonic sequences. */
export class InMemoryEventStore implements EventStore {
  private readonly events: StoredEvent[] = [];
  private readonly sequences = new Map<TenantId, number>();
  private readonly bus: EventBus;
  private readonly now: () => Date;
  private readonly nextId: () => string;

  constructor(options: EventStoreOptions = {}) {
    this.bus = options.bus ?? new EventBus();
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => `evt_${this.events.length + 1}`);
  }

  append<P>(event: PublishableEvent<P>): DomainEvent<P> {
    if (!event.type.trim()) throw new DomainError('VALIDATION', 'Event type is required');
    const recordedAt = isoTimestamp(this.now());
    const envelope: DomainEvent<P> = deepFreeze({
      eventId: this.nextId(),
      tenantId: event.tenantId,
      type: event.type,
      version: event.version ?? 1,
      occurredAt: event.occurredAt ?? recordedAt,
      recordedAt,
      actor: event.actor,
      subject: event.subject,
      correlationId: event.correlationId,
      ...(event.causationId ? { causationId: event.causationId } : {}),
      payload: event.payload,
    });
    const sequence = (this.sequences.get(event.tenantId) ?? 0) + 1;
    this.sequences.set(event.tenantId, sequence);
    this.events.push(Object.freeze({ sequence, event: envelope }));
    this.bus.publish(envelope);
    return envelope;
  }

  read(tenantId: TenantId, afterSequence = 0): readonly StoredEvent[] {
    return this.events.filter((entry) => entry.event.tenantId === tenantId && entry.sequence > afterSequence);
  }

  all(): readonly StoredEvent[] {
    return [...this.events];
  }

  latestSequence(tenantId: TenantId): number {
    return this.sequences.get(tenantId) ?? 0;
  }
}
