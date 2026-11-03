/** All time in the platform flows through a Clock so date engines, retention
 * and audit timestamps are deterministic under test. */
export interface Clock { now(): Date; }

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  #t: number;
  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.#t = new Date(start).getTime();
    if (Number.isNaN(this.#t)) throw new Error(`invalid FakeClock start: ${start}`);
  }
  now(): Date { return new Date(this.#t); }
  set(t: Date | string): void { this.#t = new Date(t).getTime(); }
  advanceMs(ms: number): void { this.#t += ms; }
  advanceDays(days: number): void { this.#t += days * 86_400_000; }
}

export const iso = (d: Date): string => d.toISOString();
export const parseIso = (s: string): Date => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO date: ${s}`);
  return d;
};
