/** In-process domain event bus. Events are immutable, tenant-scoped facts;
 * subscribers are observers only — a throwing subscriber never breaks the
 * publisher (errors are collected and surfaced via drainErrors). */
import type { TenantId, UserId } from './ids.ts';

export interface DomainEvent<T extends string = string, P = unknown> {
  readonly type: T;
  readonly tenantId: TenantId;
  readonly actorId: UserId | null;
  readonly occurredAt: string;
  readonly payload: Readonly<P>;
}

type Handler = (e: DomainEvent) => void | Promise<void>;

export class EventBus {
  #handlers = new Map<string, Set<Handler>>();
  #errors: unknown[] = [];
  readonly history: DomainEvent[] = [];

  on(type: string, h: Handler): () => void {
    let set = this.#handlers.get(type);
    if (!set) { set = new Set(); this.#handlers.set(type, set); }
    set.add(h);
    return () => set.delete(h);
  }
  async publish<T extends string, P>(e: DomainEvent<T, P>): Promise<void> {
    const evt = Object.freeze({ ...e, payload: Object.freeze({ ...(e.payload as object) }) });
    this.history.push(evt as DomainEvent);
    const hs = [...(this.#handlers.get(e.type) ?? []), ...(this.#handlers.get('*') ?? [])];
    for (const h of hs) {
      try { await h(evt as DomainEvent); } catch (err) { this.#errors.push(err); }
    }
  }
  drainErrors(): unknown[] { const out = this.#errors; this.#errors = []; return out; }
  clearHistory(): void { this.history.length = 0; }
}
