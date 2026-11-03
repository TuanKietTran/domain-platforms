import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { HolidayCalendar, addBusinessDays as _abd, addDays, addMonths, noticeDeadline } from '../src/obligations/dates.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

test('date engine: month-end clamping and day arithmetic', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // leap year
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('business days skip weekends and holidays', () => {
  const cal = new HolidayCalendar(['2026-01-05']); // Monday holiday
  // Fri 2026-01-02 + 1 business day -> Tue 2026-01-06 (Mon is holiday, weekend skipped)
  assert.equal(cal.addBusinessDays('2026-01-02', 1), '2026-01-06');
  assert.equal(cal.addBusinessDays('2026-01-06', -1), '2026-01-02');
  assert.equal(cal.businessDaysBetween('2026-01-02', '2026-01-06'), 1);
  assert.equal(cal.isBusinessDay('2026-01-03'), false); // Saturday
});

test('notice deadlines honor calendar, business and month rules', () => {
  const cal = new HolidayCalendar();
  assert.equal(noticeDeadline('2026-07-01', { kind: 'calendar_days', days: 30 }, cal), '2026-06-01');
  assert.equal(noticeDeadline('2026-07-01', { kind: 'months', months: 3 }, cal), '2026-04-01');
  assert.equal(noticeDeadline('2026-01-07', { kind: 'business_days', days: 2 }, cal), '2026-01-05'); // Wed -> Mon
});

test('obligation status derives from the injected clock', () => {
  const w = makeWorld(); // today = 2026-01-05
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const soon = w.obligations.create(w.counselCtx, { contractId: c.id, kind: 'review', title: 'Quarterly review', dueDate: '2026-01-15' });
  const future = w.obligations.create(w.counselCtx, { contractId: c.id, kind: 'payment', title: 'Annual fee', dueDate: '2026-06-01' });
  const past = w.obligations.create(w.counselCtx, { contractId: c.id, kind: 'filing', title: 'Late filing', dueDate: '2026-01-01' });
  assert.equal(w.obligations.statusOf(soon), 'due_soon');
  assert.equal(w.obligations.statusOf(future), 'open');
  assert.equal(w.obligations.statusOf(past), 'overdue');
  w.clock.advanceDays(20);
  assert.equal(w.obligations.statusOf(w.obligations.get(w.counselCtx, future.id)), 'open');
  assert.equal(w.obligations.statusOf(w.obligations.get(w.counselCtx, soon.id)), 'overdue');
});

test('completing a recurring obligation spawns the next occurrence', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const o = w.obligations.create(w.counselCtx, { contractId: c.id, kind: 'review', title: 'Monthly review', dueDate: '2026-02-01', recurrence: 'monthly' });
  w.obligations.complete(w.counselCtx, o.id);
  const all = w.obligations.list(w.counselCtx, { contractId: c.id });
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.id !== o.id)?.dueDate, '2026-03-01');
  assert.throws(() => w.obligations.complete(w.counselCtx, o.id),
    (e: unknown) => e instanceof DomainError && e.code === 'CONFLICT');
});

test('waiver requires a reason and is terminal', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const o = w.obligations.create(w.counselCtx, { contractId: c.id, kind: 'other', title: 'Optional report', dueDate: '2026-02-01' });
  assert.throws(() => w.obligations.waive(w.counselCtx, o.id, '  '),
    (e: unknown) => e instanceof DomainError && e.code === 'VALIDATION');
  const waived = w.obligations.waive(w.counselCtx, o.id, 'counterparty agreed in writing');
  assert.equal(w.obligations.statusOf(waived), 'waived');
});
