export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  private current: Date;

  constructor(start: string | Date = '2026-01-05T09:00:00.000Z') {
    this.current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: string | Date): void {
    this.current = typeof value === 'string' ? new Date(value) : new Date(value.getTime());
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error('advance requires a finite duration');
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }
}
