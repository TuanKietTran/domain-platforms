import type { Clock } from './clock.js';
import { DomainError } from './errors.js';
import type { AuditId, IdGenerator, TenantId } from './ids.js';
import { canonicalJson, cloneJson, deepFreeze, sha256 } from './util.js';

export type AuditOutcome = 'succeeded' | 'failed' | 'denied';

export interface AuditActor {
  readonly kind: 'user' | 'customer' | 'system' | 'agent' | 'integration';
  readonly id: string;
}

export interface AuditEntry {
  readonly id: AuditId;
  readonly tenantId: TenantId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: AuditOutcome;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly previousHash: string;
  readonly hash: string;
}

export interface AppendAuditInput {
  readonly tenantId: TenantId;
  readonly actor: AuditActor;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: AuditOutcome;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
  readonly correlationId?: string;
}

export interface AuditVerification {
  readonly valid: boolean;
  readonly checked: number;
  readonly brokenAt?: { tenantId: string; sequence: number; reason: string };
}

const GENESIS = '0'.repeat(64);

/**
 * Hash-chained, append-only audit trail. Every entry commits to the previous
 * entry hash, so removing or editing any historical record is detectable.
 */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private readonly heads = new Map<string, string>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  append(input: AppendAuditInput): AuditEntry {
    const sequence = (this.sequences.get(input.tenantId) ?? 0) + 1;
    const previousHash = this.heads.get(input.tenantId) ?? GENESIS;
    const body = {
      id: this.ids.next('aud') as AuditId,
      tenantId: input.tenantId,
      sequence,
      occurredAt: this.clock.now().toISOString(),
      actor: { kind: input.actor.kind, id: input.actor.id },
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: input.outcome,
      summary: input.summary,
      // Clone caller-owned data so the stored entry never aliases (and
      // deepFreeze never freezes) objects the caller still holds.
      metadata: cloneJson(input.metadata ?? {}),
      correlationId: input.correlationId,
      previousHash,
    };
    const hash = sha256(`${previousHash}:${canonicalJson(body)}`);
    const entry: AuditEntry = deepFreeze({ ...body, hash });
    this.entries.push(entry);
    this.heads.set(input.tenantId, hash);
    this.sequences.set(input.tenantId, sequence);
    return entry;
  }

  list(tenantId: TenantId): readonly AuditEntry[] {
    return this.entries.filter((entry) => entry.tenantId === tenantId);
  }

  forSubject(tenantId: TenantId, subjectType: string, subjectId: string): readonly AuditEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.tenantId === tenantId &&
        entry.subjectType === subjectType &&
        entry.subjectId === subjectId,
    );
  }

  verify(tenantId?: TenantId): AuditVerification {
    const selected = tenantId
      ? this.entries.filter((entry) => entry.tenantId === tenantId)
      : this.entries;
    const result = verifyAuditEntries(selected);
    if (!result.valid) return result;
    // Anchor the recomputed chain to the heads recorded at append time, so
    // dropping trailing entries is detected here, not just edits or gaps.
    const lastByTenant = new Map<string, AuditEntry>();
    for (const entry of selected) lastByTenant.set(entry.tenantId, entry);
    // Anchor every tenant known at append time, not only tenants still
    // present in `selected`: dropping all of a tenant's entries leaves no
    // last entry to compare, so that case must fail explicitly.
    const expectedTenants: string[] = tenantId ? [tenantId] : [...this.heads.keys()];
    for (const tenant of expectedTenants) {
      const last = lastByTenant.get(tenant);
      if (!last) {
        if (this.heads.has(tenant)) {
          return {
            valid: false,
            checked: result.checked,
            brokenAt: { tenantId: tenant, sequence: this.sequences.get(tenant) ?? 0, reason: 'audit head mismatch' },
          };
        }
        continue;
      }
      if (this.heads.get(tenant) !== last.hash || this.sequences.get(tenant) !== last.sequence) {
        return {
          valid: false,
          checked: result.checked,
          brokenAt: { tenantId: tenant, sequence: last.sequence, reason: 'audit head mismatch' },
        };
      }
    }
    return result;
  }

  exportEntries(): readonly AuditEntry[] {
    return this.entries.map((entry) => JSON.parse(JSON.stringify(entry)) as AuditEntry);
  }
}

/** Recomputes the chain from exported entries; used by independent verifiers. */
export function verifyAuditEntries(entries: readonly AuditEntry[]): AuditVerification {
  const heads = new Map<string, string>();
  const sequences = new Map<string, number>();
  let checked = 0;
  for (const entry of entries) {
    const previousHash = heads.get(entry.tenantId) ?? GENESIS;
    const expectedSequence = (sequences.get(entry.tenantId) ?? 0) + 1;
    if (entry.previousHash !== previousHash) {
      return {
        valid: false,
        checked,
        brokenAt: { tenantId: entry.tenantId, sequence: entry.sequence, reason: 'previous hash mismatch' },
      };
    }
    if (entry.sequence !== expectedSequence) {
      return {
        valid: false,
        checked,
        brokenAt: { tenantId: entry.tenantId, sequence: entry.sequence, reason: 'sequence gap' },
      };
    }
    const body = {
      id: entry.id,
      tenantId: entry.tenantId,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      actor: entry.actor,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      outcome: entry.outcome,
      summary: entry.summary,
      metadata: entry.metadata,
      correlationId: entry.correlationId,
      previousHash: entry.previousHash,
    };
    const hash = sha256(`${entry.previousHash}:${canonicalJson(body)}`);
    if (hash !== entry.hash) {
      return {
        valid: false,
        checked,
        brokenAt: { tenantId: entry.tenantId, sequence: entry.sequence, reason: 'entry hash mismatch' },
      };
    }
    heads.set(entry.tenantId, entry.hash);
    sequences.set(entry.tenantId, entry.sequence);
    checked += 1;
  }
  return { valid: true, checked };
}

export function requireValidAudit(log: AuditLog, tenantId?: TenantId): void {
  const result = log.verify(tenantId);
  if (!result.valid) {
    throw new DomainError('INTEGRITY_FAILURE', 'Audit trail integrity check failed', {
      brokenAt: result.brokenAt,
    });
  }
}
