import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/finance/money.js';
import { DomainError } from '../src/core/errors.js';

const usd = (n: bigint | number) => new Money(n, 'USD');
const isDomain = (code: string) => (err: unknown) => err instanceof DomainError && (err as DomainError & { code?: string }).code === code;

describe('Money construction (integer minor units, never floats)', () => {
  it('stores integer minor units and currency, frozen', () => {
    const m = usd(1234);
    assert.equal(m.minorUnits, 1234n);
    assert.equal(m.currency, 'USD');
    assert.ok(Object.isFrozen(m));
  });
  it('rejects float, NaN and unsafe-integer amounts', () => {
    for (const bad of [1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => usd(bad), isDomain('VALIDATION'));
    }
    assert.throws(() => usd('100' as unknown as number), isDomain('VALIDATION'));
  });
  it('rejects non-ISO currency codes', () => {
    for (const bad of ['usd', 'US', 'USDD', 'U1D', '']) assert.throws(() => new Money(1, bad), isDomain('VALIDATION'));
  });
  it('accepts bigint amounts beyond the safe-integer range exactly', () => {
    const m = new Money(9007199254740993n, 'USD');
    assert.equal(m.add(usd(1)).minorUnits, 9007199254740994n);
  });
});

describe('Money arithmetic', () => {
  it('add, subtract and negate are exact', () => {
    assert.equal(usd(100).add(usd(250)).minorUnits, 350n);
    assert.equal(usd(100).subtract(usd(250)).minorUnits, -150n);
    assert.equal(usd(100).negate().minorUnits, -100n);
    assert.equal(usd(-100).abs().minorUnits, 100n);
    assert.ok(usd(100).abs().equals(usd(100)));
  });
  it('throws DomainError CURRENCY_MISMATCH on add, subtract and compare across currencies', () => {
    const eur = new Money(100, 'EUR');
    assert.throws(() => usd(100).add(eur), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => usd(100).subtract(eur), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => usd(100).compare(eur), isDomain('MONEY_CURRENCY_MISMATCH'));
  });
  it('compares, equals and classifies', () => {
    assert.equal(usd(5).compare(usd(7)), -1);
    assert.equal(usd(7).compare(usd(7)), 0);
    assert.equal(usd(9).compare(usd(7)), 1);
    assert.ok(usd(7).equals(usd(7n)));
    assert.equal(usd(7).equals(new Money(7, 'EUR')), false);
    assert.ok(usd(1).isPositive() && usd(-1).isNegative() && usd(0).isZero());
    assert.ok(usd(2).isGreaterThan(usd(1)) && usd(1).isLessThan(usd(2)));
    assert.ok(usd(2).isGreaterThanOrEqual(usd(2)) && usd(2).isLessThanOrEqual(usd(2)));
  });
  it('multiplies by integers only, exactly', () => {
    assert.equal(usd(333).multiply(3).minorUnits, 999n);
    assert.equal(usd(333).multiply(-2n).minorUnits, -666n);
    assert.throws(() => usd(1).multiply(1.5), isDomain('VALIDATION'));
  });
  it('Money.sum adds a list and handles the empty list only with a currency', () => {
    assert.equal(Money.sum([usd(1), usd(2), usd(3)]).minorUnits, 6n);
    assert.equal(Money.sum([], 'EUR').currency, 'EUR');
    assert.throws(() => Money.sum([]), isDomain('VALIDATION'));
  });
});

describe('Money.allocate (no cent created or lost)', () => {
  const total = (parts: readonly Money[]) => parts.reduce((acc, p) => acc + p.minorUnits, 0n);
  it('splits evenly, giving the remainder cents to the earliest shares', () => {
    const parts = usd(100).allocateEvenly(3);
    assert.deepEqual(parts.map((p) => p.minorUnits), [34n, 33n, 33n]);
    assert.equal(total(parts), 100n);
  });
  it('splits by weights with largest remainders', () => {
    const parts = usd(101).allocate([1, 2]);
    assert.deepEqual(parts.map((p) => p.minorUnits), [34n, 67n]);
    assert.equal(total(parts), 101n);
    assert.deepEqual(usd(1000).allocate([70, 30]).map((p) => p.minorUnits), [700n, 300n]);
  });
  it('allocates negative amounts without losing a cent', () => {
    const parts = usd(-100).allocateEvenly(3);
    assert.deepEqual(parts.map((p) => p.minorUnits), [-34n, -33n, -33n]);
    assert.equal(total(parts), -100n);
  });
  it('allocates zero, and gives zero-weight shares nothing', () => {
    assert.deepEqual(usd(0).allocateEvenly(4).map((p) => p.minorUnits), [0n, 0n, 0n, 0n]);
    assert.deepEqual(usd(50).allocate([1, 0]).map((p) => p.minorUnits), [50n, 0n]);
  });
  it('rejects empty, all-zero, negative or fractional ratios', () => {
    assert.throws(() => usd(1).allocate([]), isDomain('VALIDATION'));
    assert.throws(() => usd(1).allocate([0, 0]), isDomain('VALIDATION'));
    assert.throws(() => usd(1).allocate([1, -1]), isDomain('VALIDATION'));
    assert.throws(() => usd(1).allocate([0.5, 0.5]), isDomain('VALIDATION'));
    assert.throws(() => usd(1).allocateEvenly(0), isDomain('VALIDATION'));
  });
  it('never drifts over many shares', () => {
    const parts = usd(99991).allocateEvenly(97);
    assert.equal(total(parts), 99991n);
  });
});
