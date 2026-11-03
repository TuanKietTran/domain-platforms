import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaymentBook } from '../src/finance/payments.js';
import { Money } from '../src/finance/money.js';
import { DomainError } from '../src/core/errors.js';

const usd = (n: number) => new Money(n, 'USD');
const eur = (n: number) => new Money(n, 'EUR');
const isDomain = (code: string) => (err: unknown) => err instanceof DomainError && (err as DomainError & { code?: string }).code === code;

function bookWithDraft(): { book: PaymentBook; id: string } {
  const book = new PaymentBook();
  const p = book.create({ payee: 'Acme Ltd', amount: usd(5000), method: 'bank_transfer', reference: 'INV-1', date: '2026-11-03' });
  return { book, id: p.id };
}
function scheduled(book: PaymentBook, id: string): void {
  book.approve(id);
  book.schedule(id, '2026-11-05');
}

describe('PaymentBook.create', () => {
  it('creates a frozen draft with null lifecycle fields and an auto id', () => {
    const book = new PaymentBook();
    const p = book.create({ payee: 'Acme Ltd', amount: usd(5000), method: 'bank_transfer', reference: 'INV-1', date: '2026-11-03' });
    assert.equal(p.id, 'pay-1');
    assert.equal(p.status, 'draft');
    assert.equal(p.payee, 'Acme Ltd');
    assert.equal(p.amount.minorUnits, 5000n);
    assert.equal(p.scheduledDate, null);
    assert.equal(p.settledDate, null);
    assert.equal(p.failureReason, null);
    assert.ok(Object.isFrozen(p));
    const q = book.create({ payee: 'Beta', amount: usd(100), method: 'cash', reference: 'INV-2', date: '2026-11-03' });
    assert.equal(q.id, 'pay-2');
  });
  it('honours an explicit id and all four methods', () => {
    const book = new PaymentBook();
    for (const [i, method] of (['bank_transfer', 'card', 'cash', 'cheque'] as const).entries()) {
      const p = book.create({ id: 'p' + i, payee: 'X', amount: usd(1), method, reference: 'R' + i, date: '2026-11-03' });
      assert.equal(p.method, method);
    }
    assert.equal(book.list().length, 4);
  });
  it('rejects blank payee/reference, bad method, non-Money and non-positive amounts, and bad dates', () => {
    const book = new PaymentBook();
    const base = { payee: 'Acme', amount: usd(100), method: 'card' as const, reference: 'R1', date: '2026-11-03' };
    assert.throws(() => book.create({ ...base, payee: '  ' }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, reference: '' }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, method: 'crypto' as never }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, amount: 100 as never }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, amount: usd(0) }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, amount: usd(-5) }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, date: 'not-a-date' }), isDomain('VALIDATION'));
    assert.throws(() => book.create({ ...base, id: ' ' }), isDomain('VALIDATION'));
    assert.equal(book.list().length, 0);
  });
  it('rejects duplicate ids and duplicate references as CONFLICT (reference is the idempotency key)', () => {
    const { book, id } = bookWithDraft();
    assert.throws(() => book.create({ id, payee: 'Other', amount: usd(1), method: 'cash', reference: 'NEW', date: '2026-11-03' }), isDomain('CONFLICT'));
    assert.throws(() => book.create({ payee: 'Other', amount: usd(1), method: 'cash', reference: 'INV-1', date: '2026-11-03' }), isDomain('CONFLICT'));
    assert.equal(book.list().length, 1);
  });
  it('throws NOT_FOUND for an unknown payment', () => {
    const { book } = bookWithDraft();
    assert.throws(() => book.payment('missing'), isDomain('NOT_FOUND'));
    assert.throws(() => book.approve('missing'), isDomain('NOT_FOUND'));
  });
});

describe('PaymentBook lifecycle', () => {
  it('walks draft -> approved -> scheduled -> settled storing dates', () => {
    const { book, id } = bookWithDraft();
    assert.equal(book.approve(id).status, 'approved');
    const s = book.schedule(id, '2026-11-05');
    assert.equal(s.status, 'scheduled');
    assert.equal(s.scheduledDate, '2026-11-05');
    const done = book.settle(id, '2026-11-06');
    assert.equal(done.status, 'settled');
    assert.equal(done.settledDate, '2026-11-06');
    assert.equal(book.payment(id).status, 'settled');
  });
  it('rejects illegal transitions as STATE_INVALID, and settled/cancelled are terminal', () => {
    const { book, id } = bookWithDraft();
    assert.throws(() => book.schedule(id, '2026-11-05'), isDomain('STATE_INVALID'));
    assert.throws(() => book.settle(id, '2026-11-05'), isDomain('STATE_INVALID'));
    assert.throws(() => book.failPayment(id, 'bounced'), isDomain('STATE_INVALID'));
    book.approve(id);
    assert.throws(() => book.approve(id), isDomain('STATE_INVALID'));
    assert.throws(() => book.settle(id, '2026-11-05'), isDomain('STATE_INVALID'));
    book.schedule(id, '2026-11-05');
    book.settle(id, '2026-11-06');
    for (const move of [() => book.approve(id), () => book.cancel(id), () => book.schedule(id, '2026-11-07'), () => book.settle(id, '2026-11-07'), () => book.failPayment(id, 'x')]) {
      assert.throws(move, isDomain('STATE_INVALID'));
    }
    const other = book.create({ payee: 'Y', amount: usd(10), method: 'cash', reference: 'INV-9', date: '2026-11-03' });
    book.cancel(other.id);
    assert.throws(() => book.approve(other.id), isDomain('STATE_INVALID'));
  });
  it('can cancel from draft, approved, scheduled and failed', () => {
    const mk = () => { const b = new PaymentBook(); const p = b.create({ payee: 'A', amount: usd(10), method: 'cash', reference: 'R', date: '2026-11-03' }); return { b, pid: p.id }; };
    const a = mk(); assert.equal(a.b.cancel(a.pid).status, 'cancelled');
    const b1 = mk(); b1.b.approve(b1.pid); assert.equal(b1.b.cancel(b1.pid).status, 'cancelled');
    const c = mk(); scheduled(c.b, c.pid); assert.equal(c.b.cancel(c.pid).status, 'cancelled');
    const d = mk(); scheduled(d.b, d.pid); d.b.failPayment(d.pid, 'insufficient funds'); assert.equal(d.b.cancel(d.pid).status, 'cancelled');
  });
  it('records a failure reason and a failed payment can be re-scheduled (retry) and settled', () => {
    const { book, id } = bookWithDraft();
    scheduled(book, id);
    const failed = book.failPayment(id, 'insufficient funds');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'insufficient funds');
    const retry = book.schedule(id, '2026-11-08');
    assert.equal(retry.status, 'scheduled');
    assert.equal(retry.scheduledDate, '2026-11-08');
    assert.equal(retry.failureReason, null);
    assert.equal(book.settle(id, '2026-11-09').status, 'settled');
  });
  it('rejects a blank failure reason', () => {
    const { book, id } = bookWithDraft();
    scheduled(book, id);
    assert.throws(() => book.failPayment(id, '  '), isDomain('VALIDATION'));
    assert.equal(book.payment(id).status, 'scheduled');
  });
  it('validates schedule/settle date ordering', () => {
    const { book, id } = bookWithDraft();
    book.approve(id);
    assert.throws(() => book.schedule(id, '2026-11-02'), isDomain('VALIDATION'));
    assert.throws(() => book.schedule(id, 'junk'), isDomain('VALIDATION'));
    book.schedule(id, '2026-11-05');
    assert.throws(() => book.settle(id, '2026-11-04'), isDomain('VALIDATION'));
    assert.throws(() => book.settle(id, 'junk'), isDomain('VALIDATION'));
    assert.equal(book.payment(id).status, 'scheduled');
    assert.equal(book.settle(id, '2026-11-05').status, 'settled');
  });
  it('never mutates the original payment object on a transition', () => {
    const { book, id } = bookWithDraft();
    const original = book.payment(id);
    const approved = book.approve(id);
    assert.notEqual(approved, original);
    assert.equal(original.status, 'draft');
    assert.ok(Object.isFrozen(approved));
    assert.equal(approved.amount, original.amount);
    assert.equal(approved.reference, original.reference);
  });
});

describe('PaymentBook list and total', () => {
  it('lists all payments or filters by status, frozen', () => {
    const { book, id } = bookWithDraft();
    book.create({ payee: 'Beta', amount: eur(700), method: 'card', reference: 'INV-2', date: '2026-11-03' });
    book.approve(id);
    assert.equal(book.list().length, 2);
    assert.deepEqual(book.list('approved').map((p) => p.id), [id]);
    assert.deepEqual(book.list('settled'), []);
    assert.ok(Object.isFrozen(book.list()));
  });
  it('totals per status in the requested currency only, zero when empty', () => {
    const { book, id } = bookWithDraft();
    book.create({ payee: 'Beta', amount: usd(1500), method: 'card', reference: 'INV-2', date: '2026-11-03' });
    book.create({ payee: 'Gamma', amount: eur(9999), method: 'card', reference: 'INV-3', date: '2026-11-03' });
    assert.equal(book.total('draft', 'USD').minorUnits, 6500n);
    assert.equal(book.total('draft', 'EUR').minorUnits, 9999n);
    assert.equal(book.total('settled', 'USD').minorUnits, 0n);
    assert.equal(book.total('settled', 'USD').currency, 'USD');
    scheduled(book, id);
    book.settle(id, '2026-11-06');
    assert.equal(book.total('settled', 'USD').minorUnits, 5000n);
    assert.equal(book.total('draft', 'USD').minorUnits, 1500n);
  });
});
