import { DomainError, type ErrorCode } from '../core/errors.js';

type MinorInput = bigint | number;
type RatioInput = bigint | number;

const fail: (code: ErrorCode, message: string, details?: Record<string, unknown>) => never = (code, message, details) => {
  throw new DomainError(code, message, details);
};

function toMinorUnits(value: MinorInput, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return fail('VALIDATION', field + ' must be an integer number of minor units (bigint or safe integer), never a float', { field, value: String(value) });
}

function toWeight(value: RatioInput): bigint {
  const weight = toMinorUnits(value, 'allocation ratio');
  if (weight < 0n) fail('VALIDATION', 'allocation ratios must be non-negative', { ratio: String(value) });
  return weight;
}

/**
 * Money as integer minor units (cents) plus an ISO 4217 currency.
 * No float is ever accepted, stored or produced: amounts are bigint
 * minor units, arithmetic is bigint arithmetic, and allocation uses
 * integer largest-remainder distribution so shares sum exactly.
 */
export class Money {
  readonly minorUnits: bigint;
  readonly currency: string;

  constructor(minorUnits: MinorInput, currency: string) {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      fail('VALIDATION', 'currency must be an ISO 4217 code (three uppercase letters)', { currency });
    }
    this.minorUnits = toMinorUnits(minorUnits, 'minorUnits');
    this.currency = currency;
    Object.freeze(this);
  }

  static of(minorUnits: MinorInput, currency: string): Money {
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, currency);
  }

  static sum(values: readonly Money[], currency?: string): Money {
    if (values.length === 0) {
      if (currency === undefined) fail('VALIDATION', 'Money.sum of an empty list requires a currency');
      return Money.zero(currency);
    }
    let total = values[0];
    for (let i = 1; i < values.length; i++) total = total.add(values[i]);
    if (currency !== undefined && total.currency !== currency) {
      fail('MONEY_CURRENCY_MISMATCH', 'Money.sum currency does not match the summed values', { expected: currency, actual: total.currency });
    }
    return total;
  }

  private assertSameCurrency(other: Money, operation: string): void {
    if (!(other instanceof Money)) fail('VALIDATION', operation + ' requires a Money operand');
    if (other.currency !== this.currency) {
      fail('MONEY_CURRENCY_MISMATCH', 'cannot ' + operation + ' money in different currencies', { operation, left: this.currency, right: other.currency });
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  abs(): Money {
    return this.minorUnits < 0n ? this.negate() : this;
  }

  /** Exact integer scaling only; a fractional factor is refused, not rounded. */
  multiply(factor: MinorInput): Money {
    return new Money(this.minorUnits * toMinorUnits(factor, 'factor'), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compare');
    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;
    return 0;
  }

  equals(other: unknown): boolean {
    return other instanceof Money && other.currency === this.currency && other.minorUnits === this.minorUnits;
  }

  isGreaterThan(other: Money): boolean { return this.compare(other) > 0; }
  isGreaterThanOrEqual(other: Money): boolean { return this.compare(other) >= 0; }
  isLessThan(other: Money): boolean { return this.compare(other) < 0; }
  isLessThanOrEqual(other: Money): boolean { return this.compare(other) <= 0; }
  isZero(): boolean { return this.minorUnits === 0n; }
  isPositive(): boolean { return this.minorUnits > 0n; }
  isNegative(): boolean { return this.minorUnits < 0n; }

  /**
   * Split by non-negative integer weights using largest remainders.
   * The shares always sum exactly to this amount: no cent is created
   * or lost, for positive and negative amounts alike.
   */
  allocate(ratios: readonly RatioInput[]): readonly Money[] {
    if (!Array.isArray(ratios) || ratios.length === 0) fail('VALIDATION', 'allocate requires at least one ratio');
    const weights = ratios.map(toWeight);
    const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
    if (totalWeight === 0n) fail('VALIDATION', 'allocation ratios must not all be zero');
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const shares = weights.map((w) => (absolute * w) / totalWeight);
    const remainders = weights.map((w) => (absolute * w) % totalWeight);
    let leftover = absolute - shares.reduce((acc, s) => acc + s, 0n);
    const order = weights.map((_, i) => i).sort((a, b) => {
      if (remainders[a] !== remainders[b]) return remainders[a] > remainders[b] ? -1 : 1;
      return a - b;
    });
    for (const idx of order) {
      if (leftover === 0n) break;
      shares[idx] += 1n;
      leftover -= 1n;
    }
    return Object.freeze(shares.map((s) => new Money(negative ? -s : s, this.currency)));
  }

  allocateEvenly(parts: number): readonly Money[] {
    if (!Number.isSafeInteger(parts) || parts <= 0) fail('VALIDATION', 'allocateEvenly requires a positive integer part count', { parts });
    return this.allocate(new Array<number>(parts).fill(1));
  }

  toString(): string {
    return 'Money(' + this.currency + ', ' + this.minorUnits.toString() + ' minor units)';
  }

  toJSON(): { minorUnits: string; currency: string } {
    return { minorUnits: this.minorUnits.toString(), currency: this.currency };
  }
}
