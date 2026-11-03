/** Typed domain errors. Every failure path in the platform throws one of these
 * (never a bare string / generic Error) so callers can switch on `code`. */
export type ErrorCode =
  | 'NOT_FOUND' | 'FORBIDDEN' | 'TENANT_MISMATCH' | 'CONFLICT'
  | 'INVALID_TRANSITION' | 'VALIDATION' | 'LEGAL_HOLD' | 'RETENTION'
  | 'BUDGET_EXCEEDED' | 'APPROVAL_REQUIRED' | 'INTEGRITY' | 'IMMUTABLE';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const notFound = (kind: string, id: string) =>
  new DomainError('NOT_FOUND', `${kind} not found: ${id}`, { kind, id });
export const forbidden = (msg: string, details: Record<string, unknown> = {}) =>
  new DomainError('FORBIDDEN', msg, details);
export const validation = (msg: string, details: Record<string, unknown> = {}) =>
  new DomainError('VALIDATION', msg, details);
export const conflict = (msg: string, details: Record<string, unknown> = {}) =>
  new DomainError('CONFLICT', msg, details);
