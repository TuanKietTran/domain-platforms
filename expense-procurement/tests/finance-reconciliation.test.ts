import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, type InternalRecord, type StatementLine } from '../src/finance/reconciliation.js';
import { Money } from '../src/finance/money.js';
import { DomainError } from '../src/core/errors.js';

const usd = (n: number) => new Money(n, 'USD');
const eur = (n: number) => new Money(n, 'EUR');
const isDomain = (code: string) => (err: unknown) => err instanceof DomainError && (err as DomainError).code === code;
const rec = (id: string, reference: string, amount: Money, date = '2026-11-03'): InternalRecord => ({ id, reference, amount, date });
const line = (id: string, reference: string, amount: Money, date = '2026-11-04'): StatementLine => ({ id, reference, amount, date });

describe('reconcile: matched', () => {
  it('pairs by reference regardless of order, sorted by reference, balanced, frozen', () => {
    const report = reconcile(
      [rec('i2', 'INV-2', usd(700)), rec('i1', 'INV-1', usd(5000))],
      [line('s1', 'INV-1', usd(5000)), line('s2', 'INV-2', usd(700))],
    );
    assert.equal(report.isBalanced, true);
    assert.equal(report.currency, 'USD');
    assert.deepEqual(report.matched.map((p) => p.reference), ['INV-1', 'INV-2']);
    assert.deepEqual(report.matched.map((p) => [p.internalId, p.statementId]), [['i1', 's1'], ['i2', 's2']]);
    assert.equal(report.matched[0].amount.minorUnits, 5000n);
    assert.equal(report.matched[0].internalDate, '2026-11-03');
    assert.equal(report.matched[0].statementDate, '2026-11-04');
    assert.equal(report.matchedTotal.minorUnits, 5700n);
    assert.equal(report.internalTotal.minorUnits, 5700n);
    assert.equal(report.statementTotal.minorUnits, 5700n);
    assert.equal(report.difference.minorUnits, 0n);
    assert.deepEqual(report.amountMismatches, []);
    assert.deepEqual(report.onlyInternal, []);
    assert.deepEqual(report.onlyStatement, []);
    assert.ok(Object.isFrozen(report));
    assert.ok(Object.isFrozen(report.matched));
    assert.ok(Object.isFrozen(report.matched[0]));
  });
  it('matches negative amounts exactly (refunds and fees)', () => {
    const report = reconcile([rec('i1', 'REF-1', usd(-250))], [line('s1', 'REF-1', usd(-250))]);
    assert.equal(report.isBalanced, true);
    assert.equal(report.matchedTotal.minorUnits, -250n);
  });
  it('reconciles two empty lists in an explicit currency as balanced zeros', () => {
    const report = reconcile([], [], 'EUR');
    assert.equal(report.isBalanced, true);
    assert.equal(report.currency, 'EUR');
    assert.equal(report.internalTotal.minorUnits, 0n);
    assert.equal(report.statementTotal.currency, 'EUR');
    assert.equal(report.difference.minorUnits, 0n);
  });
});

describe('reconcile: discrepancies', () => {
  it('reports an amount mismatch by reference, in neither matched nor missing lists', () => {
    const report = reconcile(
      [rec('i1', 'INV-1', usd(5000)), rec('i2', 'INV-2', usd(700))],
      [line('s1', 'INV-1', usd(4999)), line('s2', 'INV-2', usd(700))],
    );
    assert.equal(report.isBalanced, false);
    assert.deepEqual(report.matched.map((p) => p.reference), ['INV-2']);
    assert.equal(report.amountMismatches.length, 1);
    const m = report.amountMismatches[0];
    assert.equal(m.internalId, 'i1');
    assert.equal(m.statementId, 's1');
    assert.equal(m.internalAmount.minorUnits, 5000n);
    assert.equal(m.statementAmount.minorUnits, 4999n);
    assert.equal(m.difference.minorUnits, -1n);
    assert.deepEqual(report.onlyInternal, []);
    assert.deepEqual(report.onlyStatement, []);
    assert.equal(report.difference.minorUnits, -1n);
  });
  it('treats a sign difference as an amount mismatch, not a match', () => {
    const report = reconcile([rec('i1', 'FEE-1', usd(-100))], [line('s1', 'FEE-1', usd(100))]);
    assert.equal(report.matched.length, 0);
    assert.equal(report.amountMismatches[0].difference.minorUnits, 200n);
  });
  it('lists references seen on only one side, sorted, with correct totals', () => {
    const report = reconcile(
      [rec('i1', 'INV-1', usd(5000)), rec('i2', 'INV-9', usd(900))],
      [line('s1', 'INV-1', usd(5000)), line('s2', 'BANK-FEE', usd(300))],
    );
    assert.equal(report.isBalanced, false);
    assert.deepEqual(report.onlyInternal.map((r) => r.reference), ['INV-9']);
    assert.deepEqual(report.onlyStatement.map((r) => r.reference), ['BANK-FEE']);
    assert.equal(report.internalTotal.minorUnits, 5900n);
    assert.equal(report.statementTotal.minorUnits, 5300n);
    assert.equal(report.difference.minorUnits, -600n);
    assert.equal(report.matchedTotal.minorUnits, 5000n);
  });
  it('is not balanced even when an offsetting mismatch and unmatched line net the difference to zero', () => {
    const report = reconcile(
      [rec('i1', 'INV-1', usd(5000))],
      [line('s1', 'INV-1', usd(5100)), line('s2', 'EXTRA', usd(-100))],
    );
    assert.equal(report.difference.minorUnits, 0n);
    assert.equal(report.isBalanced, false);
    assert.equal(report.amountMismatches.length, 1);
    assert.deepEqual(report.onlyStatement.map((r) => r.reference), ['EXTRA']);
  });
  it('handles a wholly one-sided reconciliation', () => {
    const report = reconcile([rec('i1', 'INV-1', usd(100))], []);
    assert.equal(report.currency, 'USD');
    assert.equal(report.statementTotal.minorUnits, 0n);
    assert.deepEqual(report.onlyInternal.map((r) => r.id), ['i1']);
    assert.equal(report.isBalanced, false);
  });
});

describe('reconcile: validation', () => {
  it('rejects blank ids/references, bad dates, non-Money and zero amounts, and non-arrays', () => {
    const good = [rec('i1', 'INV-1', usd(100))];
    assert.throws(() => reconcile([rec(' ', 'INV-1', usd(100))], []), isDomain('VALIDATION'));
    assert.throws(() => reconcile([rec('i1', '', usd(100))], []), isDomain('VALIDATION'));
    assert.throws(() => reconcile([rec('i1', 'INV-1', usd(100), 'junk')], []), isDomain('VALIDATION'));
    assert.throws(() => reconcile([rec('i1', 'INV-1', 100 as never)], []), isDomain('VALIDATION'));
    assert.throws(() => reconcile([rec('i1', 'INV-1', usd(0))], []), isDomain('VALIDATION'));
    assert.throws(() => reconcile('nope' as never, []), isDomain('VALIDATION'));
    assert.throws(() => reconcile([], null as never), isDomain('VALIDATION'));
    assert.throws(() => reconcile([], []), isDomain('VALIDATION'));
    assert.equal(reconcile(good, []).onlyInternal.length, 1);
  });
  it('rejects duplicate ids and duplicate references per side as CONFLICT, while the same reference across sides is the match', () => {
    assert.throws(() => reconcile([rec('i1', 'A', usd(1)), rec('i1', 'B', usd(2))], []), isDomain('CONFLICT'));
    assert.throws(() => reconcile([rec('i1', 'A', usd(1)), rec('i2', 'A', usd(1))], []), isDomain('CONFLICT'));
    assert.throws(() => reconcile([], [line('s1', 'A', usd(1)), line('s2', 'A', usd(1))]), isDomain('CONFLICT'));
    assert.equal(reconcile([rec('i1', 'A', usd(1))], [line('s1', 'A', usd(1))]).isBalanced, true);
  });
  it('rejects mixed currencies within a side, across sides, or against an explicit currency', () => {
    assert.throws(() => reconcile([rec('i1', 'A', usd(1)), rec('i2', 'B', eur(1))], []), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => reconcile([rec('i1', 'A', usd(1))], [line('s1', 'A', eur(1))]), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => reconcile([rec('i1', 'A', usd(1))], [], 'EUR'), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => reconcile([], [], 'usd'), isDomain('VALIDATION'));
  });
  it('does not mutate or freeze its inputs', () => {
    const internal = [rec('i2', 'B', usd(2)), rec('i1', 'A', usd(1))];
    const statement = [line('s1', 'A', usd(1))];
    reconcile(internal, statement);
    assert.deepEqual(internal.map((r) => r.id), ['i2', 'i1']);
    assert.equal(Object.isFrozen(internal[0]), false);
    assert.equal(Object.isFrozen(statement[0]), false);
  });
});
