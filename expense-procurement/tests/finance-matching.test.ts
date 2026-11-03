import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { proposeMatches } from '../src/finance/matching.js';
import type { InternalRecord, StatementLine } from '../src/finance/reconciliation.js';
import { Money } from '../src/finance/money.js';
import { DomainError } from '../src/core/errors.js';

const usd = (n: number) => new Money(n, 'USD');
const eur = (n: number) => new Money(n, 'EUR');
const isDomain = (code: string) => (err: unknown) => err instanceof DomainError && (err as DomainError).code === code;
const rec = (id: string, reference: string, amount: Money, date = '2026-11-03'): InternalRecord => ({ id, reference, amount, date });
const line = (id: string, reference: string, amount: Money, date = '2026-11-03'): StatementLine => ({ id, reference, amount, date });

describe('proposeMatches: proposals', () => {
  it('proposes an exact amount/date/reference pair at score 100, high confidence, frozen', () => {
    const result = proposeMatches([rec('i1', 'INV-1', usd(5000))], [line('s1', 'INV-1', usd(5000))]);
    assert.equal(result.currency, 'USD');
    assert.equal(result.proposals.length, 1);
    const p = result.proposals[0];
    assert.equal(p.internalId, 'i1');
    assert.equal(p.statementId, 's1');
    assert.equal(p.internalReference, 'INV-1');
    assert.equal(p.statementReference, 'INV-1');
    assert.equal(p.amount.minorUnits, 5000n);
    assert.equal(p.internalDate, '2026-11-03');
    assert.equal(p.statementDate, '2026-11-03');
    assert.equal(p.dateDifferenceDays, 0);
    assert.equal(p.score, 100);
    assert.equal(p.confidence, 'high');
    assert.deepEqual(p.reasons, ['exact_amount', 'same_date', 'exact_reference']);
    assert.equal(result.proposedTotal.minorUnits, 5000n);
    assert.deepEqual(result.unmatchedInternal, []);
    assert.deepEqual(result.unmatchedStatement, []);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.proposals));
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.reasons));
    assert.ok(Object.isFrozen(result.unmatchedInternal));
    assert.ok(Object.isFrozen(result.unmatchedStatement));
  });
  it('sorts proposals by internal reference regardless of input order and totals them', () => {
    const result = proposeMatches(
      [rec('i2', 'INV-2', usd(700)), rec('i1', 'INV-1', usd(5000))],
      [line('s2', 'INV-2', usd(700)), line('s1', 'INV-1', usd(5000))],
    );
    assert.deepEqual(result.proposals.map((p) => p.internalReference), ['INV-1', 'INV-2']);
    assert.deepEqual(result.proposals.map((p) => [p.internalId, p.statementId]), [['i1', 's1'], ['i2', 's2']]);
    assert.equal(result.proposedTotal.minorUnits, 5700n);
    assert.equal(result.proposedTotal.currency, 'USD');
  });
  it('matches negative amounts exactly (refunds and fees)', () => {
    const result = proposeMatches([rec('i1', 'REF-1', usd(-250))], [line('s1', 'REF-1', usd(-250))]);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposedTotal.minorUnits, -250n);
  });
  it('handles two empty lists in an explicit currency as zero with no proposals', () => {
    const result = proposeMatches([], [], { currency: 'EUR' });
    assert.equal(result.currency, 'EUR');
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.unmatchedInternal, []);
    assert.deepEqual(result.unmatchedStatement, []);
    assert.equal(result.proposedTotal.minorUnits, 0n);
    assert.equal(result.proposedTotal.currency, 'EUR');
  });
  it('leaves one-sided and unmatched records sorted by reference in the unmatched lists', () => {
    const result = proposeMatches(
      [rec('i2', 'B-REF', usd(200)), rec('i1', 'A-REF', usd(100))],
      [line('s1', 'C-REF', usd(300))],
    );
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.unmatchedInternal.map((r) => r.reference), ['A-REF', 'B-REF']);
    assert.deepEqual(result.unmatchedStatement.map((r) => r.reference), ['C-REF']);
    assert.equal(result.proposedTotal.minorUnits, 0n);
    assert.ok(Object.isFrozen(result.unmatchedInternal[0]));
  });
});

describe('proposeMatches: scoring and confidence', () => {
  it('scores a case-insensitive reference as similar (98, high)', () => {
    const result = proposeMatches([rec('i1', 'inv-1', usd(5000))], [line('s1', 'INV-1', usd(5000))]);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].score, 98);
    assert.equal(result.proposals[0].confidence, 'high');
    assert.deepEqual(result.proposals[0].reasons, ['exact_amount', 'same_date', 'similar_reference']);
  });
  it('scores a contained reference as similar (90, high boundary)', () => {
    const result = proposeMatches([rec('i1', 'INV-1', usd(5000))], [line('s1', 'PAY-INV-1', usd(5000))]);
    assert.equal(result.proposals[0].score, 90);
    assert.equal(result.proposals[0].confidence, 'high');
    assert.ok(result.proposals[0].reasons.includes('similar_reference'));
  });
  it('scores a shared prefix of 4+ chars as similar (85, medium)', () => {
    const result = proposeMatches([rec('i1', 'INV-1000', usd(5000))], [line('s1', 'INV-1999', usd(5000))]);
    assert.equal(result.proposals[0].score, 85);
    assert.equal(result.proposals[0].confidence, 'medium');
    assert.ok(result.proposals[0].reasons.includes('similar_reference'));
  });
  it('still proposes on exact amount and date alone, with no reference reason (80, medium)', () => {
    const result = proposeMatches([rec('i1', 'AAAA', usd(5000))], [line('s1', 'ZZZZ', usd(5000))]);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].score, 80);
    assert.equal(result.proposals[0].confidence, 'medium');
    assert.deepEqual(result.proposals[0].reasons, ['exact_amount', 'same_date']);
  });
  it('decays the date component by 5 per day: exact reference 3 days apart scores 85 with close_date', () => {
    const result = proposeMatches([rec('i1', 'INV-1', usd(5000), '2026-11-03')], [line('s1', 'INV-1', usd(5000), '2026-11-06')]);
    assert.equal(result.proposals[0].dateDifferenceDays, 3);
    assert.equal(result.proposals[0].score, 85);
    assert.equal(result.proposals[0].confidence, 'medium');
    assert.deepEqual(result.proposals[0].reasons, ['exact_amount', 'close_date', 'exact_reference']);
  });
  it('hits the medium boundary at 75 (1 day apart, no reference similarity)', () => {
    const result = proposeMatches([rec('i1', 'AAAA', usd(5000), '2026-11-03')], [line('s1', 'ZZZZ', usd(5000), '2026-11-04')]);
    assert.equal(result.proposals[0].score, 75);
    assert.equal(result.proposals[0].confidence, 'medium');
  });
  it('falls to low confidence at the edge of the window with no reference similarity (65, low)', () => {
    const result = proposeMatches([rec('i1', 'AAAA', usd(5000), '2026-11-03')], [line('s1', 'ZZZZ', usd(5000), '2026-11-06')]);
    assert.equal(result.proposals[0].score, 65);
    assert.equal(result.proposals[0].confidence, 'low');
  });
});

describe('proposeMatches: candidate gating', () => {
  it('never proposes on amount mismatch, even with an exact reference and date', () => {
    const result = proposeMatches([rec('i1', 'INV-1', usd(5000))], [line('s1', 'INV-1', usd(5001))]);
    assert.deepEqual(result.proposals, []);
    assert.equal(result.unmatchedInternal.length, 1);
    assert.equal(result.unmatchedStatement.length, 1);
  });
  it('treats a sign difference as an amount mismatch, not a candidate', () => {
    const result = proposeMatches([rec('i1', 'INV-1', usd(5000))], [line('s1', 'INV-1', usd(-5000))]);
    assert.deepEqual(result.proposals, []);
  });
  it('applies the default 3-day window: 3 days in, 4 days out', () => {
    const inside = proposeMatches([rec('i1', 'INV-1', usd(100), '2026-11-03')], [line('s1', 'INV-1', usd(100), '2026-11-06')]);
    assert.equal(inside.proposals.length, 1);
    const outside = proposeMatches([rec('i1', 'INV-1', usd(100), '2026-11-03')], [line('s1', 'INV-1', usd(100), '2026-11-07')]);
    assert.deepEqual(outside.proposals, []);
    assert.equal(outside.unmatchedInternal.length, 1);
    assert.equal(outside.unmatchedStatement.length, 1);
  });
  it('honours maxDateDifferenceDays 0 (same day only) and a wider custom window', () => {
    const strict = proposeMatches([rec('i1', 'INV-1', usd(100), '2026-11-03')], [line('s1', 'INV-1', usd(100), '2026-11-04')], { maxDateDifferenceDays: 0 });
    assert.deepEqual(strict.proposals, []);
    const wide = proposeMatches([rec('i1', 'INV-1', usd(100), '2026-11-03')], [line('s1', 'INV-1', usd(100), '2026-11-09')], { maxDateDifferenceDays: 7 });
    assert.equal(wide.proposals.length, 1);
    assert.equal(wide.proposals[0].dateDifferenceDays, 6);
    assert.equal(wide.proposals[0].score, 80);
  });
});

describe('proposeMatches: greedy one-to-one assignment', () => {
  it('gives a contested statement line to the highest-scoring internal record', () => {
    const result = proposeMatches(
      [rec('i2', 'ZZZZ', usd(5000)), rec('i1', 'INV-1', usd(5000))],
      [line('s1', 'INV-1', usd(5000))],
    );
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].internalId, 'i1');
    assert.deepEqual(result.unmatchedInternal.map((r) => r.id), ['i2']);
    assert.deepEqual(result.unmatchedStatement, []);
  });
  it('gives a contested internal record to the highest-scoring statement line', () => {
    const result = proposeMatches(
      [rec('i1', 'INV-1', usd(5000))],
      [line('s2', 'ZZZZ', usd(5000)), line('s1', 'INV-1', usd(5000))],
    );
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].statementId, 's1');
    assert.deepEqual(result.unmatchedStatement.map((r) => r.id), ['s2']);
    assert.deepEqual(result.unmatchedInternal, []);
  });
  it('breaks score ties deterministically by internal reference, regardless of input order', () => {
    const result = proposeMatches(
      [rec('i2', 'BBBB', usd(5000)), rec('i1', 'AAAA', usd(5000))],
      [line('s1', 'ZZZZ', usd(5000))],
    );
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].score, 80);
    assert.equal(result.proposals[0].internalId, 'i1');
    assert.deepEqual(result.unmatchedInternal.map((r) => r.id), ['i2']);
  });
});

describe('proposeMatches: validation', () => {
  it('rejects blank ids/references, bad dates, non-Money and zero amounts, and non-arrays', () => {
    assert.throws(() => proposeMatches([rec('', 'INV-1', usd(1))], []), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([rec('i1', '  ', usd(1))], []), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([rec('i1', 'INV-1', usd(1), 'not-a-date')], []), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([], [line('s1', 'INV-1', usd(1), '')]), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([rec('i1', 'INV-1', 100 as never)], []), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([rec('i1', 'INV-1', usd(0))], []), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches('nope' as never, []), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([], null as never), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([], []), isDomain('VALIDATION'));
  });
  it('rejects duplicate ids and duplicate references per side as CONFLICT, while the same reference across sides is a candidate', () => {
    assert.throws(() => proposeMatches([rec('i1', 'A', usd(1)), rec('i1', 'B', usd(2))], []), isDomain('CONFLICT'));
    assert.throws(() => proposeMatches([rec('i1', 'A', usd(1)), rec('i2', 'A', usd(1))], []), isDomain('CONFLICT'));
    assert.throws(() => proposeMatches([], [line('s1', 'A', usd(1)), line('s1', 'B', usd(1))]), isDomain('CONFLICT'));
    assert.throws(() => proposeMatches([], [line('s1', 'A', usd(1)), line('s2', 'A', usd(1))]), isDomain('CONFLICT'));
    assert.equal(proposeMatches([rec('i1', 'A', usd(1))], [line('s1', 'A', usd(1))]).proposals.length, 1);
  });
  it('rejects mixed currencies within a side, across sides, or against an explicit currency', () => {
    assert.throws(() => proposeMatches([rec('i1', 'A', usd(1)), rec('i2', 'B', eur(1))], []), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => proposeMatches([rec('i1', 'A', usd(1))], [line('s1', 'A', eur(1))]), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => proposeMatches([rec('i1', 'A', usd(1))], [], { currency: 'EUR' }), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => proposeMatches([], [], { currency: 'usd' }), isDomain('VALIDATION'));
    assert.equal(proposeMatches([rec('i1', 'A', usd(1))], [], { currency: 'USD' }).currency, 'USD');
  });
  it('rejects invalid options and invalid maxDateDifferenceDays, accepting the 0 and 366 boundaries', () => {
    assert.throws(() => proposeMatches([], [], null as never), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([], [], [] as never), isDomain('VALIDATION'));
    assert.throws(() => proposeMatches([], [], 'x' as never), isDomain('VALIDATION'));
    for (const bad of [-1, 367, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => proposeMatches([], [], { currency: 'USD', maxDateDifferenceDays: bad }), isDomain('VALIDATION'));
    }
    assert.throws(() => proposeMatches([], [], { currency: 'USD', maxDateDifferenceDays: '3' as never }), isDomain('VALIDATION'));
    assert.equal(proposeMatches([], [], { currency: 'USD', maxDateDifferenceDays: 0 }).currency, 'USD');
    assert.equal(proposeMatches([], [], { currency: 'USD', maxDateDifferenceDays: 366 }).currency, 'USD');
  });
  it('does not mutate or freeze its inputs, and unmatched entries are frozen copies', () => {
    const internal = [rec('i2', 'B', usd(2)), rec('i1', 'A', usd(1))];
    const statement = [line('s1', 'A', usd(1))];
    const result = proposeMatches(internal, statement);
    assert.deepEqual(internal.map((r) => r.id), ['i2', 'i1']);
    assert.equal(Object.isFrozen(internal[0]), false);
    assert.equal(Object.isFrozen(statement[0]), false);
    assert.equal(result.unmatchedInternal.length, 1);
    assert.notEqual(result.unmatchedInternal[0], internal[0]);
    assert.ok(Object.isFrozen(result.unmatchedInternal[0]));
  });
});
