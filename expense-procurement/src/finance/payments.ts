import { DomainError, type ErrorCode } from '../core/errors.js';
import { Money } from './money.js';

const fail: (code: ErrorCode, message: string, details?: Record<string, unknown>) => never = (code, message, details) => {
  throw new DomainError(code, message, details);
};

const nonBlank = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) fail('VALIDATION', field + ' must be a non-blank string', { field });
  return value;
};

const validDate = (value: unknown, field: string): string => {
  const date = nonBlank(value, field);
  if (Number.isNaN(Date.parse(date))) fail('VALIDATION', field + ' must be a valid date string', { field, date });
  return date;
};

export type PaymentMethod = 'bank_transfer' | 'card' | 'cash' | 'cheque';
export type PaymentStatus = 'draft' | 'approved' | 'scheduled' | 'settled' | 'failed' | 'cancelled';

export interface Payment {
  readonly id: string;
  readonly payee: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly reference: string;
  readonly status: PaymentStatus;
  readonly createdDate: string;
  readonly scheduledDate: string | null;
  readonly settledDate: string | null;
  readonly failureReason: string | null;
}

export interface CreatePaymentInput {
  readonly id?: string;
  readonly payee: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly reference: string;
  readonly date: string;
}

const METHODS: readonly string[] = ['bank_transfer', 'card', 'cash', 'cheque'];

/** Legal status moves. Settled and cancelled are terminal; a failed
 * payment may only be re-scheduled (retry) or cancelled. */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  draft: ['approved', 'cancelled'],
  approved: ['scheduled', 'cancelled'],
  scheduled: ['settled', 'failed', 'cancelled'],
  failed: ['scheduled', 'cancelled'],
  settled: [],
  cancelled: [],
};

/**
 * Register of payment instructions. A payment is created once, for a
 * positive Money amount under a unique external reference (a second
 * instruction carrying the same reference is a duplicate, not a new
 * payment), and then moves only along the legal status transitions.
 * Payments are immutable and frozen: a transition stores a new frozen
 * copy, never edits the amount, payee or reference in place.
 */
export class PaymentBook {
  private readonly payments = new Map<string, Payment>();
  private readonly references = new Map<string, string>();
  private sequence = 0;

  private nextId(): string {
    let id = '';
    do { this.sequence += 1; id = 'pay-' + this.sequence; } while (this.payments.has(id));
    return id;
  }

  create(input: CreatePaymentInput): Payment {
    const payee = nonBlank(input?.payee, 'payee');
    const reference = nonBlank(input?.reference, 'reference');
    const date = validDate(input?.date, 'payment date');
    if (!METHODS.includes(input?.method)) fail('VALIDATION', 'payment method is invalid', { method: String(input?.method) });
    if (!(input?.amount instanceof Money)) fail('VALIDATION', 'payment amount must be Money');
    if (!input.amount.isPositive()) fail('VALIDATION', 'payment amount must be positive', { amount: input.amount.toString() });
    const id = input.id === undefined ? this.nextId() : nonBlank(input.id, 'payment id');
    if (this.payments.has(id)) fail('CONFLICT', 'payment already exists', { paymentId: id });
    if (this.references.has(reference)) fail('CONFLICT', 'a payment with this reference already exists', { reference, paymentId: this.references.get(reference) });
    const payment: Payment = Object.freeze({
      id, payee, amount: input.amount, method: input.method, reference,
      status: 'draft', createdDate: date, scheduledDate: null, settledDate: null, failureReason: null,
    });
    this.payments.set(id, payment);
    this.references.set(reference, id);
    return payment;
  }

  payment(id: string): Payment {
    const found = this.payments.get(id);
    if (!found) fail('NOT_FOUND', 'payment not found', { paymentId: id });
    return found;
  }

  list(status?: PaymentStatus): readonly Payment[] {
    return Object.freeze([...this.payments.values()].filter((p) => status === undefined || p.status === status));
  }

  private move(id: string, to: PaymentStatus, patch: Partial<Payment>): Payment {
    const current = this.payment(id);
    if (!TRANSITIONS[current.status].includes(to)) {
      fail('STATE_INVALID', 'payment cannot move from ' + current.status + ' to ' + to, { paymentId: id, from: current.status, to });
    }
    const updated: Payment = Object.freeze({ ...current, ...patch, status: to });
    this.payments.set(id, updated);
    return updated;
  }

  approve(id: string): Payment {
    return this.move(id, 'approved', {});
  }

  schedule(id: string, date: string): Payment {
    const scheduledDate = validDate(date, 'scheduled date');
    const current = this.payment(id);
    if (Date.parse(scheduledDate) < Date.parse(current.createdDate)) {
      fail('VALIDATION', 'scheduled date must not precede the payment date', { paymentId: id, scheduledDate, createdDate: current.createdDate });
    }
    return this.move(id, 'scheduled', { scheduledDate, failureReason: null });
  }

  settle(id: string, date: string): Payment {
    const settledDate = validDate(date, 'settled date');
    const current = this.payment(id);
    if (current.scheduledDate !== null && Date.parse(settledDate) < Date.parse(current.scheduledDate)) {
      fail('VALIDATION', 'settled date must not precede the scheduled date', { paymentId: id, settledDate, scheduledDate: current.scheduledDate });
    }
    return this.move(id, 'settled', { settledDate });
  }

  failPayment(id: string, reason: string): Payment {
    return this.move(id, 'failed', { failureReason: nonBlank(reason, 'failure reason') });
  }

  cancel(id: string): Payment {
    return this.move(id, 'cancelled', {});
  }

  /** Sum of payments currently in one status; all must share the given currency. */
  total(status: PaymentStatus, currency: string): Money {
    const amounts = this.list(status).filter((p) => p.amount.currency === currency).map((p) => p.amount);
    return Money.sum(amounts, currency);
  }
}
