import { DomainError } from './errors.js';

declare const idBrand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [idBrand]: B };

export type TenantId = Branded<string, 'TenantId'>;
export type UserId = Branded<string, 'UserId'>;
export type CustomerId = Branded<string, 'CustomerId'>;
export type TicketId = Branded<string, 'TicketId'>;
export type MessageId = Branded<string, 'MessageId'>;
export type TeamId = Branded<string, 'TeamId'>;
export type ArticleId = Branded<string, 'ArticleId'>;
export type PolicyId = Branded<string, 'PolicyId'>;
export type RunId = Branded<string, 'RunId'>;
export type ApprovalId = Branded<string, 'ApprovalId'>;
export type EventId = Branded<string, 'EventId'>;
export type AuditId = Branded<string, 'AuditId'>;
export type MacroId = Branded<string, 'MacroId'>;
export type ScorecardId = Branded<string, 'ScorecardId'>;
export type IntakeId = Branded<string, 'IntakeId'>;
export type NotificationId = Branded<string, 'NotificationId'>;
export type AutomationId = Branded<string, 'AutomationId'>;
export type CrmRecordId = Branded<string, 'CrmRecordId'>;
export type ProductId = Branded<string, 'ProductId'>;

function brand<T extends string>(kind: string, value: string): T {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('VALIDATION', 'Identifier must be a non-empty string', { kind });
  }
  return value as T;
}

export const asTenantId = (v: string): TenantId => brand('TenantId', v);
export const asUserId = (v: string): UserId => brand('UserId', v);
export const asCustomerId = (v: string): CustomerId => brand('CustomerId', v);
export const asTicketId = (v: string): TicketId => brand('TicketId', v);
export const asMessageId = (v: string): MessageId => brand('MessageId', v);
export const asTeamId = (v: string): TeamId => brand('TeamId', v);
export const asArticleId = (v: string): ArticleId => brand('ArticleId', v);
export const asPolicyId = (v: string): PolicyId => brand('PolicyId', v);
export const asRunId = (v: string): RunId => brand('RunId', v);
export const asApprovalId = (v: string): ApprovalId => brand('ApprovalId', v);
export const asEventId = (v: string): EventId => brand('EventId', v);
export const asAuditId = (v: string): AuditId => brand('AuditId', v);
export const asMacroId = (v: string): MacroId => brand('MacroId', v);
export const asScorecardId = (v: string): ScorecardId => brand('ScorecardId', v);
export const asIntakeId = (v: string): IntakeId => brand('IntakeId', v);
export const asNotificationId = (v: string): NotificationId => brand('NotificationId', v);
export const asAutomationId = (v: string): AutomationId => brand('AutomationId', v);
export const asCrmRecordId = (v: string): CrmRecordId => brand('CrmRecordId', v);
export const asProductId = (v: string): ProductId => brand('ProductId', v);

export interface IdGenerator {
  next(prefix: string): string;
}

/** Deterministic generator: stable identifiers make tests and traces reproducible. */
export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();
  private readonly pad: number;

  constructor(readonly seed = 0, pad = 6) {
    this.pad = pad;
  }

  next(prefix: string): string {
    const current = this.counters.get(prefix) ?? this.seed;
    const next = current + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(this.pad, '0')}`;
  }
}

/** Collision-resistant generator for production wiring. */
export class RandomIdGenerator implements IdGenerator {
  private counter = 0;

  next(prefix: string): string {
    this.counter += 1;
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}${this.counter.toString(36)}${random}`;
  }
}
