import { DomainError, type ErrorCode } from '../core/errors.js';
import { Money } from './money.js';
import type { InternalRecord, StatementLine } from './reconciliation.js';

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

export interface MatchingOptions {
  /** Maximum absolute difference between the two dates, in whole days. Default 3. */
  readonly maxDateDifferenceDays?: number;
  /** Required when both lists are empty; must match the records otherwise. */
  readonly currency?: string;
}

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface ProposedMatch {
  readonly internalId: string;
  readonly statementId: string;
  readonly internalReference: string;
  readonly statementReference: string;
  readonly amount: Money;
  readonly internalDate: string;
  readonly statementDate: string;
  readonly dateDifferenceDays: number;
  /** 60 for the exact amount, + up to 20 for date closeness, + up to 20 for reference similarity. */
  readonly score: number;
  readonly confidence: MatchConfidence;
  readonly reasons: readonly string[];
}

export interface MatchingResult {
  readonly currency: string;
  readonly proposals: readonly ProposedMatch[];
  readonly unmatchedInternal: readonly InternalRecord[];
  readonly unmatchedStatement: readonly StatementLine[];
  readonly proposedTotal: Money;
}

type Side = 'internal' | 'statement';
const DAY_MS = 86_400_000;
const DEFAULT_MAX_DATE_DIFFERENCE_DAYS = 3;

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
    if (references.has(reference)) fail('CONFLICT', 'duplicate ' + side + ' reference', { reference });
    ids.add(id);
    references.add(reference);
  }
  return records;
}

function sharedCurrency(internal: readonly InternalRecord[], statement: readonly StatementLine[], requested: string | undefined): string {
  const amounts = [...internal, ...statement].map((r) => r.amount);
  if (amounts.length === 0) {
    if (requested === undefined) fail('VALIDATION', 'matching two empty lists requires a currency');
    return new Money(0n, requested).currency;
  }
  const currency = amounts[0].currency;
  for (const amount of amounts) {
    if (amount.currency !== currency) fail('MONEY_CURRENCY_MISMATCH', 'all matched amounts must share one currency', { expected: currency, actual: amount.currency });
  }
  if (requested !== undefined && requested !== currency) {
    fail('MONEY_CURRENCY_MISMATCH', 'requested currency does not match the records', { expected: requested, actual: currency });
  }
  return currency;
}

function referenceScore(internalReference: string, statementReference: string): { points: number; kind: 'exact' | 'similar' | 'none' } {
  if (internalReference === statementReference) return { points: 20, kind: 'exact' };
  const a = internalReference.trim().toUpperCase();
  const b = statementReference.trim().toUpperCase();
  if (a === b) return { points: 18, kind: 'similar' };
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.includes(shorter)) return { points: 10, kind: 'similar' };
  let prefix = 0;
  while (prefix < shorter.length && a[prefix] === b[prefix]) prefix += 1;
  if (prefix >= 4) return { points: 5, kind: 'similar' };
  return { points: 0, kind: 'none' };
}

interface Candidate extends ProposedMatch { readonly sortScore: number }

/**
 * Automatic match proposals for the records exact reconciliation
 * (see reconciliation.ts) leaves behind, where the reference was
 * mistyped, reformatted or omitted on one side. A pair is only ever
 * a candidate when the amounts are exactly equal (sign included)
 * and the dates are within maxDateDifferenceDays; reference
 * similarity raises the score but can never create a candidate on
 * its own. Assignment is one-to-one and greedy: candidates are
 * taken in score order (ties broken deterministically by date
 * difference, then references, then ids), so one statement line
 * can never be proposed for two internal records. Proposals are
 * suggestions, not matches: nothing is reconciled until accepted.
 */
export function proposeMatches(internalInput: readonly InternalRecord[], statementInput: readonly StatementLine[], options: MatchingOptions = {}): MatchingResult {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('VALIDATION', 'matching options must be an object');
  const maxDays = options.maxDateDifferenceDays === undefined ? DEFAULT_MAX_DATE_DIFFERENCE_DAYS : options.maxDateDifferenceDays;
  if (!Number.isSafeInteger(maxDays) || maxDays < 0 || maxDays > 366) fail('VALIDATION', 'maxDateDifferenceDays must be a safe integer between 0 and 366', { maxDateDifferenceDays: maxDays });
  const internal = validateSide(internalInput, 'internal');
  const statement = validateSide(statementInput, 'statement');
  const shared = sharedCurrency(internal, statement, options.currency);

  const candidates: Candidate[] = [];
  for (const record of internal) {
    for (const line of statement) {
      if (!record.amount.equals(line.amount)) continue;
      const diffMs = Math.abs(Date.parse(record.date) - Date.parse(line.date));
      if (diffMs > maxDays * DAY_MS) continue;
      const dateDifferenceDays = Math.round(diffMs / DAY_MS);
      const ref = referenceScore(record.reference, line.reference);
      const datePoints = Math.max(0, 20 - 5 * dateDifferenceDays);
      const score = 60 + datePoints + ref.points;
      const reasons: string[] = ['exact_amount'];
      if (dateDifferenceDays === 0) reasons.push('same_date'); else reasons.push('close_date');
      if (ref.kind === 'exact') reasons.push('exact_reference'); else if (ref.kind === 'similar') reasons.push('similar_reference');
      candidates.push(Object.freeze({
        internalId: record.id, statementId: line.id,
        internalReference: record.reference, statementReference: line.reference,
        amount: record.amount, internalDate: record.date, statementDate: line.date,
        dateDifferenceDays, score,
        confidence: (score >= 90 ? 'high' : score >= 75 ? 'medium' : 'low') as MatchConfidence,
        reasons: Object.freeze(reasons), sortScore: score,
      }));
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    a.dateDifferenceDays - b.dateDifferenceDays ||
    (a.internalReference < b.internalReference ? -1 : a.internalReference > b.internalReference ? 1 : 0) ||
    (a.statementReference < b.statementReference ? -1 : a.statementReference > b.statementReference ? 1 : 0) ||
    (a.internalId < b.internalId ? -1 : a.internalId > b.internalId ? 1 : 0) ||
    (a.statementId < b.statementId ? -1 : a.statementId > b.statementId ? 1 : 0));

  const usedInternal = new Set<string>();
  const usedStatement = new Set<string>();
  const chosen: ProposedMatch[] = [];
  for (const candidate of candidates) {
    if (usedInternal.has(candidate.internalId) || usedStatement.has(candidate.statementId)) continue;
    usedInternal.add(candidate.internalId);
    usedStatement.add(candidate.statementId);
    const { sortScore: _ignored, ...proposal } = candidate;
    chosen.push(Object.freeze(proposal));
  }
  chosen.sort((a, b) => a.internalReference < b.internalReference ? -1 : a.internalReference > b.internalReference ? 1 : a.statementReference < b.statementReference ? -1 : a.statementReference > b.statementReference ? 1 : 0);

  const byReference = <T extends { reference: string }>(a: T, b: T): number => a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
  const unmatchedInternal = internal.filter((r) => !usedInternal.has(r.id)).map((r) => Object.freeze({ ...r })).sort(byReference);
  const unmatchedStatement = statement.filter((l) => !usedStatement.has(l.id)).map((l) => Object.freeze({ ...l })).sort(byReference);

  return Object.freeze({
    currency: shared,
    proposals: Object.freeze(chosen),
    unmatchedInternal: Object.freeze(unmatchedInternal),
    unmatchedStatement: Object.freeze(unmatchedStatement),
    proposedTotal: Money.sum(chosen.map((p) => p.amount), shared),
  });
}
