export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Controllable clock. Time-based behaviour (SLA deadlines, retention, reminders)
 * is always expressed against this port so the whole platform stays testable.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = '2026-01-05T09:00:00.000Z') {
    this.current = new Date(start).getTime();
    if (Number.isNaN(this.current)) throw new TypeError('FakeClock requires a valid start instant');
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): Date {
    if (milliseconds < 0) throw new RangeError('FakeClock cannot move backwards');
    this.current += milliseconds;
    return this.now();
  }

  set(instant: Date | string | number): Date {
    const next = new Date(instant).getTime();
    if (Number.isNaN(next)) throw new TypeError('FakeClock requires a valid instant');
    this.current = next;
    return this.now();
  }
}

export const DURATION = {
  seconds: (n: number) => n * 1000,
  minutes: (n: number) => n * 60_000,
  hours: (n: number) => n * 3_600_000,
  days: (n: number) => n * 86_400_000,
} as const;

export function addMilliseconds(instant: Date | string, deltaMs: number): Date {
  return new Date(new Date(instant).getTime() + deltaMs);
}

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}
