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

export interface InternalRecord {
  readonly id: string;
  readonly reference: string;
  readonly amount: Money;
  readonly date: string;
}

export interface StatementLine {
  readonly id: string;
  readonly reference: string;
  readonly amount: Money;
  readonly date: string;
}

export interface MatchedPair {
  readonly internalId: string;
  readonly statementId: string;
  readonly reference: string;
  readonly amount: Money;
  readonly internalDate: string;
  readonly statementDate: string;
}

export interface AmountMismatch {
  readonly internalId: string;
  readonly statementId: string;
  readonly reference: string;
  readonly internalAmount: Money;
  readonly statementAmount: Money;
  /** statementAmount - internalAmount, in the shared currency. */
  readonly difference: Money;
}

export interface ReconciliationReport {
  readonly currency: string;
  readonly matched: readonly MatchedPair[];
  readonly amountMismatches: readonly AmountMismatch[];
  /** Internal records with no statement line carrying their reference. */
  readonly onlyInternal: readonly InternalRecord[];
  /** Statement lines with no internal record carrying their reference. */
  readonly onlyStatement: readonly StatementLine[];
  readonly matchedTotal: Money;
  readonly internalTotal: Money;
  readonly statementTotal: Money;
  /** statementTotal - internalTotal. Zero alone does not mean balanced:
   * an amount mismatch and an offsetting unmatched line can net to zero. */
  readonly difference: Money;
  readonly isBalanced: boolean;
}

type Side = 'internal' | 'statement';

function validateSide<T extends InternalRecord>(records: readonly T[], side: Side): readonly T[] {
  if (!Array.isArray(records)) fail('VALIDATION', side + ' records must be an array');
  const ids = new Set<string>();
  const references = new Set<string>();
  for (const record of records) {
    const id = nonBlank(record?.id, side + ' record id');
    const reference = nonBlank(record?.reference, side + ' reference');
    validDate(record?.date, side + ' date');
    if (!(record?.amount instanceof Money)) fail('VALIDATION', side + ' amount must be Money', { id });
    if (record.amount.isZero()) fail('VALIDATION', side + ' amount must be non-zero', { id });
    if (ids.has(id)) fail('CONFLICT', 'duplicate ' + side + ' record id', { id });
    if (references.has(reference)) fail('CONFLICT', 'duplicate ' + side + ' reference: a reference may appear only once per side', { reference });
    ids.add(id);
    references.add(reference);
  }
  return records;
}

function sharedCurrency(internal: readonly InternalRecord[], statement: readonly StatementLine[], requested: string | undefined): string {
  const amounts = [...internal, ...statement].map((r) => r.amount);
  if (amounts.length === 0) {
    if (requested === undefined) fail('VALIDATION', 'reconciling two empty lists requires a currency');
    return new Money(0n, requested).currency;
  }
  const currency = amounts[0].currency;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      fail('MONEY_CURRENCY_MISMATCH', 'all reconciled amounts must share one currency', { expected: currency, actual: amount.currency });
    }
  }
  if (requested !== undefined && requested !== currency) {
    fail('MONEY_CURRENCY_MISMATCH', 'requested currency does not match the records', { expected: requested, actual: currency });
  }
  return currency;
}

const byReference = <T extends { reference: string }>(a: T, b: T): number =>
  a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;

/**
 * Bank reconciliation: compare internal records against an external
 * statement, pairing lines by their unique reference. A pair with equal
 * amounts (sign included) is matched; a pair whose amounts differ is an
 * amount mismatch and is matched in neither direction; a reference seen
 * on only one side is outstanding on that side. References and ids must
 * be unique per side, every amount must be non-zero Money, and all
 * amounts must share one currency. The report is frozen, its lists are
 * sorted by reference, and neither input is mutated.
 */
export function reconcile(
  internalInput: readonly InternalRecord[],
  statementInput: readonly StatementLine[],
  currency?: string,
): ReconciliationReport {
  const internal = validateSide(internalInput, 'internal');
  const statement = validateSide(statementInput, 'statement');
  const shared = sharedCurrency(internal, statement, currency);

  const statementByReference = new Map(statement.map((line) => [line.reference, line]));
  const matched: MatchedPair[] = [];
  const amountMismatches: AmountMismatch[] = [];
  const onlyInternal: InternalRecord[] = [];
  const consumed = new Set<string>();

  for (const record of internal) {
    const line = statementByReference.get(record.reference);
    if (line === undefined) {
      onlyInternal.push(Object.freeze({ ...record }));
      continue;
    }
    consumed.add(line.id);
    if (record.amount.equals(line.amount)) {
      matched.push(Object.freeze({
        internalId: record.id, statementId: line.id, reference: record.reference,
        amount: record.amount, internalDate: record.date, statementDate: line.date,
      }));
    } else {
      amountMismatches.push(Object.freeze({
        internalId: record.id, statementId: line.id, reference: record.reference,
        internalAmount: record.amount, statementAmount: line.amount,
        difference: line.amount.subtract(record.amount),
      }));
    }
  }
  const onlyStatement = statement.filter((line) => !consumed.has(line.id) && !internal.some((r) => r.reference === line.reference)).map((line) => Object.freeze({ ...line }));

  matched.sort(byReference);
  amountMismatches.sort(byReference);
  onlyInternal.sort(byReference);
  onlyStatement.sort(byReference);

  const internalTotal = Money.sum(internal.map((r) => r.amount), shared);
  const statementTotal = Money.sum(statement.map((r) => r.amount), shared);
  const report: ReconciliationReport = Object.freeze({
    currency: shared,
    matched: Object.freeze(matched),
    amountMismatches: Object.freeze(amountMismatches),
    onlyInternal: Object.freeze(onlyInternal),
    onlyStatement: Object.freeze(onlyStatement),
    matchedTotal: Money.sum(matched.map((p) => p.amount), shared),
    internalTotal,
    statementTotal,
    difference: statementTotal.subtract(internalTotal),
    isBalanced: matched.length === internal.length && matched.length === statement.length,
  });
  return report;
}
