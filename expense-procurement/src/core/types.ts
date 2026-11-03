import { DomainError } from './errors.js';

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, 'TenantId'>;
export type UserId = Brand<string, 'UserId'>;
export type ExpenseReportId = Brand<string, 'ExpenseReportId'>;
export type RequisitionId = Brand<string, 'RequisitionId'>;
export type PurchaseOrderId = Brand<string, 'PurchaseOrderId'>;
export type GoodsReceiptId = Brand<string, 'GoodsReceiptId'>;
export type InvoiceId = Brand<string, 'InvoiceId'>;
export type VendorId = Brand<string, 'VendorId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type JournalEntryId = Brand<string, 'JournalEntryId'>;
export type ApprovalProcessId = Brand<string, 'ApprovalProcessId'>;
export type AgentRunId = Brand<string, 'AgentRunId'>;

export type CurrencyCode = 'USD' | 'EUR' | 'GBP';

/** Calendar date in ISO form (YYYY-MM-DD). */
export type IsoDate = Brand<string, 'IsoDate'>;
/** Instant in ISO-8601 UTC form. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(value: string): IsoDate {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new DomainError('DATE_INVALID', `Invalid ISO date: ${value}`);
  }
  return value as IsoDate;
}

export function isoDateFrom(date: Date): IsoDate {
  return date.toISOString().slice(0, 10) as IsoDate;
}

export function isoTimestamp(date: Date): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}

function assertId(value: string): string {
  if (!value.trim()) {
    throw new DomainError('VALIDATION', 'Identifier must be non-empty');
  }
  return value;
}

export function tenantId(value: string): TenantId {
  return assertId(value) as TenantId;
}

export function userId(value: string): UserId {
  return assertId(value) as UserId;
}

export function expenseReportId(value: string): ExpenseReportId {
  return assertId(value) as ExpenseReportId;
}

export function requisitionId(value: string): RequisitionId {
  return assertId(value) as RequisitionId;
}

export function purchaseOrderId(value: string): PurchaseOrderId {
  return assertId(value) as PurchaseOrderId;
}

export function goodsReceiptId(value: string): GoodsReceiptId {
  return assertId(value) as GoodsReceiptId;
}

export function invoiceId(value: string): InvoiceId {
  return assertId(value) as InvoiceId;
}

export function vendorId(value: string): VendorId {
  return assertId(value) as VendorId;
}

export function documentId(value: string): DocumentId {
  return assertId(value) as DocumentId;
}

export function paymentId(value: string): PaymentId {
  return assertId(value) as PaymentId;
}

export function journalEntryId(value: string): JournalEntryId {
  return assertId(value) as JournalEntryId;
}

export function approvalProcessId(value: string): ApprovalProcessId {
  return assertId(value) as ApprovalProcessId;
}

export function agentRunId(value: string): AgentRunId {
  return assertId(value) as AgentRunId;
}

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: number, currency: CurrencyCode = 'USD'): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError('MONEY_INVALID', 'Money amounts must be whole minor units', { amountMinor });
  }
  return Object.freeze({ amountMinor, currency });
}

export function zeroMoney(currency: CurrencyCode = 'USD'): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError('MONEY_CURRENCY_MISMATCH', `Cannot combine ${a.currency} and ${b.currency}`, {
      left: a.currency,
      right: b.currency,
    });
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negateMoney(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}

export function sumMoney(values: readonly Money[], currency: CurrencyCode = 'USD'): Money {
  return values.reduce((acc, value) => addMoney(acc, value), zeroMoney(currency));
}

/** Multiply by a decimal factor, rounding half away from zero at minor-unit precision. */
export function mulMoney(value: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new DomainError('MONEY_INVALID', 'Multiplier must be finite', { factor });
  }
  const raw = value.amountMinor * factor;
  const rounded = Math.sign(raw) * Math.round(Math.abs(raw));
  return money(rounded, value.currency);
}

/** Percentage helper: basis points of a money amount (500 bps = 5%). */
export function percentOf(value: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints)) {
    throw new DomainError('MONEY_INVALID', 'Basis points must be an integer', { basisPoints });
  }
  return mulMoney(value, basisPoints / 10_000);
}

/**
 * Split money by integer weights without losing a minor unit. The largest
 * remainder receives any residual cents, which keeps allocations reconcilable.
 */
export function allocateMoney(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new DomainError('MONEY_INVALID', 'At least one allocation weight is required');
  }
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new DomainError('MONEY_INVALID', 'Allocation weights must be non-negative integers', { weights });
  }
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0) {
    throw new DomainError('MONEY_INVALID', 'Allocation weights must sum to a positive value');
  }
  const sign = Math.sign(total.amountMinor);
  const absolute = Math.abs(total.amountMinor);
  const shares = weights.map((weight) => Math.floor((absolute * weight) / sum));
  let residual = absolute - shares.reduce((acc, share) => acc + share, 0);
  const order = weights
    .map((weight, index) => ({ index, remainder: (absolute * weight) % sum }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of order) {
    if (residual <= 0) break;
    shares[item.index] = (shares[item.index] ?? 0) + 1;
    residual -= 1;
  }
  return shares.map((share) => money(sign * share, total.currency));
}

export function formatMoney(value: Money): string {
  const sign = value.amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(value.amountMinor);
  const major = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return `${sign}${value.currency} ${major.toLocaleString('en-US')}.${cents}`;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export function pageRequest(limit = 50, offset = 0): PageRequest {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new DomainError('PAGE_INVALID', 'Page limit must be between 1 and 500', { limit });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError('PAGE_INVALID', 'Page offset must be non-negative', { offset });
  }
  return Object.freeze({ limit, offset });
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export function paginate<T>(items: readonly T[], request: PageRequest): Page<T> {
  return Object.freeze({
    items: Object.freeze(items.slice(request.offset, request.offset + request.limit)),
    total: items.length,
    limit: request.limit,
    offset: request.offset,
  });
}
