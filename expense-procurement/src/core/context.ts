import type { Actor } from './events.js';
import type { TenantId, UserId } from './types.js';
import { DomainError } from './errors.js';

export interface CommandContext {
  readonly tenantId: TenantId;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly now: Date;
}

export interface CommandContextInput {
  readonly tenantId: TenantId;
  readonly actor: Actor;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly now?: Date;
}

export function commandContext(input: CommandContextInput): CommandContext {
  if (!input.tenantId) throw new DomainError('VALIDATION', 'Tenant is required');
  if (!input.actor?.id) throw new DomainError('VALIDATION', 'Actor is required');
  const now = input.now ?? new Date();
  return Object.freeze({
    tenantId: input.tenantId,
    actor: input.actor,
    correlationId: input.correlationId ?? `cor_${now.getTime().toString(36)}`,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    now,
  });
}

export function requireHuman(ctx: CommandContext): UserId {
  if (ctx.actor.kind !== 'user') {
    throw new DomainError('FORBIDDEN', 'A human principal is required for this action', { actor: ctx.actor.id });
  }
  return ctx.actor.id as UserId;
}
