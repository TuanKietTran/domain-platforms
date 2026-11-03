import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/finance/ledger.js';
import { Money } from '../src/finance/money.js';
import { DomainError } from '../src/core/errors.js';

const usd = (n: number) => new Money(n, 'USD');
const eur = (n: number) => new Money(n, 'EUR');
const isDomain = (code: string) => (err: unknown) => err instanceof DomainError && (err as DomainError & { code?: string }).code === code;

function seeded(): Ledger {
  const ledger = new Ledger();
  ledger.addAccount({ id: 'cash', name: 'Cash', currency: 'USD', type: 'asset' });
  ledger.addAccount({ id: 'revenue', name: 'Revenue', currency: 'USD', type: 'income' });
  ledger.addAccount({ id: 'cash-eur', name: 'Cash EUR', currency: 'EUR', type: 'asset' });
  ledger.addAccount({ id: 'revenue-eur', name: 'Revenue EUR', currency: 'EUR', type: 'income' });
  return ledger;
}

describe('Ledger accounts', () => {
  it('rejects duplicate accounts, invalid types and unknown lookups', () => {
    const ledger = seeded();
    assert.throws(() => ledger.addAccount({ id: 'cash', name: 'Again', currency: 'USD', type: 'asset' }), isDomain('CONFLICT'));
    assert.throws(() => ledger.addAccount({ id: 'x', name: 'X', currency: 'USD', type: 'bogus' as never }), isDomain('VALIDATION'));
    assert.throws(() => ledger.balance('nope'), isDomain('NOT_FOUND'));
  });
});

describe('Ledger.post (double entry)', () => {
  it('posts a balanced entry and updates balances', () => {
    const ledger = seeded();
    const entry = ledger.post({ id: 'e1', date: '2026-11-03', memo: 'Sale', postings: [{ accountId: 'cash', debit: usd(10000) }, { accountId: 'revenue', credit: usd(10000) }] });
    assert.equal(entry.id, 'e1');
    assert.equal(ledger.balance('cash').minorUnits, 10000n);
    assert.equal(ledger.balance('revenue').minorUnits, -10000n);
    assert.equal(ledger.trialBalance().get('cash')?.minorUnits, 10000n);
  });
  it('balances per currency in a multi-currency entry', () => {
    const ledger = seeded();
    ledger.post({ date: '2026-11-03', memo: 'Two sales', postings: [{ accountId: 'cash', debit: usd(500) }, { accountId: 'revenue', credit: usd(500) }, { accountId: 'cash-eur', debit: eur(700) }, { accountId: 'revenue-eur', credit: eur(700) }] });
    assert.equal(ledger.balance('cash-eur').minorUnits, 700n);
  });
  it('rejects unbalanced entries, including per-currency imbalance', () => {
    const ledger = seeded();
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'Bad', postings: [{ accountId: 'cash', debit: usd(100) }, { accountId: 'revenue', credit: usd(99) }] }), isDomain('LEDGER_UNBALANCED'));
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'Bad FX', postings: [{ accountId: 'cash', debit: usd(100) }, { accountId: 'revenue', credit: usd(100) }, { accountId: 'cash-eur', debit: eur(50) }, { accountId: 'revenue-eur', credit: eur(49) }] }), isDomain('LEDGER_UNBALANCED'));
  });
  it('rejects unknown accounts, wrong-currency postings, both-sided and non-positive postings', () => {
    const ledger = seeded();
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'X', postings: [{ accountId: 'ghost', debit: usd(1) }, { accountId: 'revenue', credit: usd(1) }] }), isDomain('NOT_FOUND'));
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'X', postings: [{ accountId: 'cash', debit: eur(1) }, { accountId: 'revenue', credit: usd(1) }] }), isDomain('MONEY_CURRENCY_MISMATCH'));
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'X', postings: [{ accountId: 'cash', debit: usd(1), credit: usd(1) }, { accountId: 'revenue', credit: usd(1) }] }), isDomain('VALIDATION'));
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'X', postings: [{ accountId: 'cash', debit: usd(0) }, { accountId: 'revenue', credit: usd(0) }] }), isDomain('VALIDATION'));
    assert.throws(() => ledger.post({ date: '2026-11-03', memo: 'X', postings: [{ accountId: 'cash', debit: usd(1) }] }), isDomain('VALIDATION'));
  });
  it('rejects duplicate entry ids and generates ids when omitted', () => {
    const ledger = seeded();
    const postings = [{ accountId: 'cash', debit: usd(1) }, { accountId: 'revenue', credit: usd(1) }];
    ledger.post({ id: 'dup', date: '2026-11-03', memo: 'One', postings });
    assert.throws(() => ledger.post({ id: 'dup', date: '2026-11-03', memo: 'Two', postings }), isDomain('CONFLICT'));
    const auto = ledger.post({ date: '2026-11-03', memo: 'Auto', postings });
    assert.match(auto.id, /^je-/);
  });
  it('posted entries are deeply frozen', () => {
    const ledger = seeded();
    const entry = ledger.post({ date: '2026-11-03', memo: 'Sale', postings: [{ accountId: 'cash', debit: usd(5) }, { accountId: 'revenue', credit: usd(5) }] });
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.postings) && Object.isFrozen(entry.postings[0]));
  });
});

describe('Ledger.reverse (reversal, not edit)', () => {
  it('reversing swaps both sides, links the entries and zeroes the balances', () => {
    const ledger = seeded();
    const original = ledger.post({ id: 'e1', date: '2026-11-03', memo: 'Sale', postings: [{ accountId: 'cash', debit: usd(4200) }, { accountId: 'revenue', credit: usd(4200) }] });
    const reversal = ledger.reverse('e1', { date: '2026-11-04' });
    assert.equal(reversal.reversalOf, 'e1');
    assert.equal(reversal.postings[0].credit?.minorUnits, 4200n);
    assert.equal(reversal.postings[1].debit?.minorUnits, 4200n);
    assert.equal(ledger.entry('e1').reversedBy, reversal.id);
    assert.equal(original.postings[0].debit?.minorUnits, 4200n);
    assert.equal(ledger.balance('cash').minorUnits, 0n);
    assert.equal(ledger.balance('revenue').minorUnits, 0n);
  });
  it('rejects double reversal, reversing a reversal, and unknown entries', () => {
    const ledger = seeded();
    ledger.post({ id: 'e1', date: '2026-11-03', memo: 'Sale', postings: [{ accountId: 'cash', debit: usd(1) }, { accountId: 'revenue', credit: usd(1) }] });
    const reversal = ledger.reverse('e1', { date: '2026-11-04' });
    assert.throws(() => ledger.reverse('e1', { date: '2026-11-05' }), isDomain('CONFLICT'));
    assert.throws(() => ledger.reverse(reversal.id, { date: '2026-11-05' }), isDomain('CONFLICT'));
    assert.throws(() => ledger.reverse('missing', { date: '2026-11-05' }), isDomain('NOT_FOUND'));
  });
});
