import { createHash } from 'node:crypto';
import { canonicalJson, deepFreeze } from './canonical.js';
import { DomainError } from './errors.js';
import type { Actor, SubjectRef } from './events.js';
import type { IsoTimestamp, TenantId } from './types.js';
import { isoTimestamp } from './types.js';

export type AuditOutcome = 'allowed' | 'denied' | 'recorded' | 'failed';

export interface AuditEntryInput {
  readonly tenantId: TenantId;
  readonly action: string;
  readonly actor: Actor;
  readonly subject: SubjectRef;
  readonly outcome: AuditOutcome;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt?: IsoTimestamp;
}

export interface AuditEntry extends AuditEntryInput {
  readonly auditId: string;
  readonly sequence: number;
  readonly recordedAt: IsoTimestamp;
  readonly previousHash: string;
  readonly hash: string;
}

export interface AuditVerification {
  readonly valid: boolean;
  readonly entries: number;
  readonly brokenAt?: { readonly sequence: number; readonly auditId: string; readonly reason: string };
}

const GENESIS = '0'.repeat(64);

export function hashAuditEntry(entry: Omit<AuditEntry, 'hash'>): string {
  const { hash: _ignored, ...rest } = entry as AuditEntry;
  void _ignored;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

export interface AuditLogOptions {
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

/**
 * Immutable, per-tenant hash-chained audit trail.
 *
 * Every entry commits to the previous entry's hash, so deleting, reordering or
 * editing a record invalidates the chain. Entries are frozen and only exposed
 * as copies of the internal array; there is no update or delete API.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly lastHash = new Map<TenantId, string>();
  private readonly counts = new Map<TenantId, number>();
  private readonly now: () => Date;
  private readonly nextId: () => string;

  constructor(options: AuditLogOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? (() => `aud_${this.entries.length + 1}`);
  }

  append(input: AuditEntryInput): AuditEntry {
    if (!input.action.trim()) throw new DomainError('VALIDATION', 'Audit action is required');
    if (!input.correlationId.trim()) throw new DomainError('VALIDATION', 'Audit correlation id is required');
    const sequence = (this.counts.get(input.tenantId) ?? 0) + 1;
    const previousHash = this.lastHash.get(input.tenantId) ?? GENESIS;
    const base: Omit<AuditEntry, 'hash'> = {
      ...input,
      details: deepFreeze({ ...(input.details ?? {}) }),
      auditId: this.nextId(),
      sequence,
      recordedAt: isoTimestamp(this.now()),
      previousHash,
    };
    const hash = hashAuditEntry(base);
    const entry: AuditEntry = deepFreeze({ ...base, hash });
    this.entries.push(entry);
    this.lastHash.set(input.tenantId, hash);
    this.counts.set(input.tenantId, sequence);
    return entry;
  }

  get(auditId: string): AuditEntry | undefined {
    return this.entries.find((entry) => entry.auditId === auditId);
  }

  list(tenantId: TenantId, filter: { subjectType?: string; subjectId?: string; action?: string } = {}): readonly AuditEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.tenantId === tenantId &&
        (!filter.subjectType || entry.subject.type === filter.subjectType) &&
        (!filter.subjectId || entry.subject.id === filter.subjectId) &&
        (!filter.action || entry.action === filter.action),
    );
  }

  size(): number {
    return this.entries.length;
  }

  verify(tenantId?: TenantId): AuditVerification {
    let previousHash = GENESIS;
    let checked = 0;
    for (const entry of this.entries) {
      if (tenantId && entry.tenantId !== tenantId) continue;
      checked += 1;
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          entries: checked,
          brokenAt: { sequence: entry.sequence, auditId: entry.auditId, reason: 'previous hash mismatch' },
        };
      }
      const { hash, ...rest } = entry;
      if (hashAuditEntry(rest as Omit<AuditEntry, 'hash'>) !== hash) {
        return {
          valid: false,
          entries: checked,
          brokenAt: { sequence: entry.sequence, auditId: entry.auditId, reason: 'entry hash mismatch' },
        };
      }
      previousHash = hash;
    }
    return { valid: true, entries: checked };
  }

  /** Export a tenant trail for archival; the payload is self-verifying. */
  export(tenantId: TenantId): { readonly entries: readonly AuditEntry[]; readonly head: string } {
    const entries = this.list(tenantId);
    return deepFreeze({ entries, head: entries.at(-1)?.hash ?? GENESIS });
  }
}
