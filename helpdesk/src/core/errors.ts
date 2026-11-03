export type DomainErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'TRANSITION_NOT_ALLOWED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'BUDGET_EXHAUSTED'
  | 'APPROVAL_REQUIRED'
  | 'TENANT_MISMATCH'
  | 'POLICY_DENIED'
  | 'INTEGRITY_FAILURE';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

export function assertCondition(
  condition: unknown,
  code: DomainErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
