/** Business-day aware date engine (UTC, explicit holiday calendar).
 * All arithmetic is calendar-based, not millisecond-based, so DST and
 * month-length edge cases are handled by the calendar, not by luck. */
export type ISODate = string; // YYYY-MM-DD

export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function toDate(s: ISODate): Date {
  if (!isValidISODate(s)) throw new Error(`invalid ISO date: ${s}`);
  return new Date(`${s}T00:00:00.000Z`);
}
function fmt(d: Date): ISODate { return d.toISOString().slice(0, 10); }

export function addDays(date: ISODate, n: number): ISODate {
  const d = toDate(date); d.setUTCDate(d.getUTCDate() + n); return fmt(d);
}
export function addMonths(date: ISODate, n: number): ISODate {
  const d = toDate(date);
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay)); // clamp: Jan 31 + 1mo -> Feb 28/29
  return fmt(d);
}
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}
export function compare(a: ISODate, b: ISODate): number { return a < b ? -1 : a > b ? 1 : 0; }

export class HolidayCalendar {
  readonly #holidays: ReadonlySet<ISODate>;
  constructor(holidays: Iterable<ISODate> = []) { this.#holidays = new Set(holidays); }
  isWeekend(date: ISODate): boolean { const dow = toDate(date).getUTCDay(); return dow === 0 || dow === 6; }
  isHoliday(date: ISODate): boolean { return this.#holidays.has(date); }
  isBusinessDay(date: ISODate): boolean { return !this.isWeekend(date) && !this.isHoliday(date); }
  /** Move forward (n>0) or backward (n<0) by n business days. n=0 snaps forward to a business day. */
  addBusinessDays(date: ISODate, n: number): ISODate {
    let cur = date; const step = n < 0 ? -1 : 1; let remaining = Math.abs(n);
    if (remaining === 0) { while (!this.isBusinessDay(cur)) cur = addDays(cur, 1); return cur; }
    while (remaining > 0) { cur = addDays(cur, step); if (this.isBusinessDay(cur)) remaining--; }
    return cur;
  }
  businessDaysBetween(a: ISODate, b: ISODate): number {
    if (compare(a, b) > 0) return -this.businessDaysBetween(b, a);
    let count = 0; let cur = a;
    while (compare(cur, b) < 0) { cur = addDays(cur, 1); if (this.isBusinessDay(cur)) count++; }
    return count;
  }
}

/** Standalone convenience: business-day arithmetic on an empty (weekend-only) calendar unless one is supplied. */
export function addBusinessDays(date: ISODate, n: number, cal: HolidayCalendar = new HolidayCalendar()): ISODate { return cal.addBusinessDays(date, n); }

export type NoticeRule =
  | { kind: 'calendar_days'; days: number }
  | { kind: 'business_days'; days: number }
  | { kind: 'months'; months: number };
/** Deadline for serving notice `rule` before a target date (e.g. renewal). */
export function noticeDeadline(target: ISODate, rule: NoticeRule, cal: HolidayCalendar): ISODate {
  switch (rule.kind) {
    case 'calendar_days': return addDays(target, -rule.days);
    case 'business_days': return cal.addBusinessDays(target, -rule.days);
    case 'months': return addMonths(target, -rule.months);
  }
}
