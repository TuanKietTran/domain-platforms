import { randomUUID } from 'node:crypto';

export interface IdFactory {
  next(prefix: string): string;
}

/** UUID-backed identifiers with a readable prefix. */
export class UuidFactory implements IdFactory {
  next(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}

/** Deterministic identifiers for tests and seeded fixtures. */
export class SequentialIdFactory implements IdFactory {
  private counters = new Map<string, number>();

  constructor(private readonly seed = 1) {}

  next(prefix: string): string {
    const current = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, current);
    return `${prefix}_${String(this.seed).padStart(2, '0')}${String(current).padStart(4, '0')}`;
  }
}
