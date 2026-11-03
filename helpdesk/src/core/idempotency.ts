import { DomainError } from './errors.js';
import type { TenantId } from './ids.js';
import { canonicalJson, deepFreeze, sha256 } from './util.js';

export interface IdempotencyScope {
  readonly tenantId: TenantId;
  readonly key?: string;
  readonly fingerprint: string;
}

interface IdempotentRecord {
  readonly tenantId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly result: unknown;
  readonly createdAt: string;
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Replays the stored result for a repeated (tenant, key) pair. Reusing a key
 * with a different request payload is rejected instead of silently returning
 * the previous result.
 */
export class IdempotencyStore {
  private readonly records = new Map<string, IdempotentRecord>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async run<T>(scope: IdempotencyScope, operation: () => Promise<T> | T): Promise<T> {
    if (!scope.key) return await operation();
    const mapKey = `${scope.tenantId}:${scope.key}`;
    const existing = this.records.get(mapKey);
    if (existing) {
      if (existing.fingerprint !== scope.fingerprint) {
        throw new DomainError('IDEMPOTENCY_MISMATCH', 'Idempotency key reused with a different payload', {
          key: scope.key,
        });
      }
      return existing.result as T;
    }
    const pending = this.inFlight.get(mapKey);
    if (pending) {
      // A concurrent caller with the same key is already running. Replaying
      // its result is only valid for the same payload: the same key with a
      // different fingerprint is a mismatch, not a replay.
      const result = await pending;
      const record = this.records.get(mapKey);
      if (record && record.fingerprint !== scope.fingerprint) {
        throw new DomainError('IDEMPOTENCY_MISMATCH', 'Idempotency key reused with a different payload', {
          key: scope.key,
        });
      }
      return result as T;
    }

    const promise = (async () => {
      const result = await operation();
      this.records.set(
        mapKey,
        deepFreeze({
          tenantId: scope.tenantId,
          key: scope.key as string,
          fingerprint: scope.fingerprint,
          result,
          createdAt: this.now(),
        }),
      );
      return result;
    })();
    this.inFlight.set(mapKey, promise);
    try {
      return (await promise) as T;
    } finally {
      this.inFlight.delete(mapKey);
    }
  }

  has(tenantId: TenantId, key: string): boolean {
    return this.records.has(`${tenantId}:${key}`);
  }

  size(): number {
    return this.records.size;
  }
}
