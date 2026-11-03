/** Obligation tracking: recurring and one-off duties extracted from
 * contracts (renewals, notice windows, payments, filings, reviews).
 * Status is derived from due dates against an injected clock, never stored
 * stale: open -> due_soon -> overdue; completed/waived are terminal facts. */
import { DomainError } from '../core/errors.ts';
import { newObligationId, type ContractId, type ObligationId, type TenantId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext } from '../identity/index.ts';
import { assertTenant, requirePermission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';
import { addMonths, compare, diffDays, type ISODate } from './dates.ts';

export type ObligationKind = 'renewal_notice' | 'payment' | 'filing' | 'review' | 'delivery' | 'other';
export type Recurrence = 'once' | 'monthly' | 'quarterly' | 'annual';
export type ObligationStatus = 'open' | 'due_soon' | 'overdue' | 'completed' | 'waived';

export interface Obligation {
  readonly id: ObligationId; readonly tenantId: TenantId;
  readonly contractId: ContractId; readonly kind: ObligationKind;
  readonly title: string; readonly dueDate: ISODate;
  readonly recurrence: Recurrence; readonly ownerId: UserId;
  readonly completedAt: string | null; readonly waivedAt: string | null; readonly waiverReason: string | null;
  readonly createdAt: string;
}

export const DUE_SOON_DAYS = 14;

export class ObligationService {
  #items = new Map<ObligationId, Obligation>();
  readonly #clock: Clock; readonly #audit: AuditLog;
  constructor(deps: { clock: Clock; audit: AuditLog }) { this.#clock = deps.clock; this.#audit = deps.audit; }

  today(): ISODate { return this.#clock.now().toISOString().slice(0, 10); }

  create(ctx: AccessContext, input: { contractId: ContractId; kind: ObligationKind; title: string; dueDate: ISODate; recurrence?: Recurrence }): Obligation {
    requirePermission(ctx, 'obligation:write');
    if (!input.title.trim()) throw new DomainError('VALIDATION', 'obligation title is required');
    const o: Obligation = {
      id: newObligationId(), tenantId: ctx.tenantId, contractId: input.contractId,
      kind: input.kind, title: input.title, dueDate: input.dueDate,
      recurrence: input.recurrence ?? 'once', ownerId: ctx.userId,
      completedAt: null, waivedAt: null, waiverReason: null,
      createdAt: this.#clock.now().toISOString(),
    };
    this.#items.set(o.id, o);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'obligation.created', subjectType: 'obligation', subjectId: o.id, detail: { contractId: o.contractId, dueDate: o.dueDate } });
    return o;
  }
  get(ctx: AccessContext, id: ObligationId): Obligation {
    requirePermission(ctx, 'obligation:read');
    const o = this.#items.get(id);
    if (!o) throw new DomainError('NOT_FOUND', `obligation not found: ${id}`);
    assertTenant(ctx, o.tenantId);
    return o;
  }
  statusOf(o: Obligation): ObligationStatus {
    if (o.completedAt) return 'completed';
    if (o.waivedAt) return 'waived';
    const days = diffDays(this.today(), o.dueDate);
    if (days < 0) return 'overdue';
    if (days <= DUE_SOON_DAYS) return 'due_soon';
    return 'open';
  }
  list(ctx: AccessContext, filter: { contractId?: ContractId; status?: ObligationStatus } = {}): Obligation[] {
    requirePermission(ctx, 'obligation:read');
    return [...this.#items.values()]
      .filter((o) => o.tenantId === ctx.tenantId)
      .filter((o) => filter.contractId === undefined || o.contractId === filter.contractId)
      .filter((o) => filter.status === undefined || this.statusOf(o) === filter.status)
      .sort((a, b) => compare(a.dueDate, b.dueDate));
  }
  complete(ctx: AccessContext, id: ObligationId): Obligation {
    requirePermission(ctx, 'obligation:write');
    const o = this.get(ctx, id);
    if (o.completedAt || o.waivedAt) throw new DomainError('CONFLICT', 'obligation already closed');
    const done: Obligation = { ...o, completedAt: this.#clock.now().toISOString() };
    this.#items.set(id, done);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'obligation.completed', subjectType: 'obligation', subjectId: id });
    // Recurring obligations spawn their next occurrence on completion.
    if (o.recurrence !== 'once') {
      const months = o.recurrence === 'monthly' ? 1 : o.recurrence === 'quarterly' ? 3 : 12;
      this.create(ctx, { contractId: o.contractId, kind: o.kind, title: o.title, dueDate: addMonths(o.dueDate, months), recurrence: o.recurrence });
    }
    return done;
  }
  waive(ctx: AccessContext, id: ObligationId, reason: string): Obligation {
    requirePermission(ctx, 'obligation:write');
    if (!reason.trim()) throw new DomainError('VALIDATION', 'waiver requires a reason');
    const o = this.get(ctx, id);
    if (o.completedAt || o.waivedAt) throw new DomainError('CONFLICT', 'obligation already closed');
    const w: Obligation = { ...o, waivedAt: this.#clock.now().toISOString(), waiverReason: reason };
    this.#items.set(id, w);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'obligation.waived', subjectType: 'obligation', subjectId: id, detail: { reason } });
    return w;
  }
}
