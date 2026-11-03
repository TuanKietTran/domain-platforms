export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'STATE_INVALID'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'MATCHING_FAILED'
  | 'LEDGER_UNBALANCED'
  | 'DATE_INVALID'
  | 'MONEY_INVALID'
  | 'MONEY_CURRENCY_MISMATCH'
  | 'MONEY_ROUNDING'
  | 'PAGE_INVALID'
  | 'MODEL_UNAVAILABLE'
  | 'DOCUMENT_INVALID'
  | 'RULE_INVALID'
  | 'AGENT_INVALID'
  | 'UNSUPPORTED';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function invariant(condition: unknown, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) {
    throw new DomainError('VALIDATION', message, details);
  }
}

export function notFound(entity: string, id: string): never {
  throw new DomainError('NOT_FOUND', `${entity} not found`, { entity, id });
}

export function conflict(message: string, details?: Record<string, unknown>): never {
  throw new DomainError('CONFLICT', message, details);
}

export function forbidden(message: string, details?: Record<string, unknown>): never {
  throw new DomainError('FORBIDDEN', message, details);
}

export function invalidState(message: string, details?: Record<string, unknown>): never {
  throw new DomainError('STATE_INVALID', message, details);
}
