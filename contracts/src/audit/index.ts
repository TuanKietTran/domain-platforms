/** Append-only, hash-chained audit log. Entries cannot be edited or deleted
 * through the API; verify() detects any tampering with stored history.
 * Legal holds block purge; retention purge only touches expired, unheld
 * entries and records the purge itself as a new entry. */
import { createHash } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { newAuditEventId, type AuditEventId, type TenantId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';

export type AuditAction =
  | 'contract.created' | 'contract.transitioned' | 'contract.version.created'
  | 'document.created' | 'document.deleted' | 'document.hold.placed' | 'document.hold.released'
  | 'obligation.created' | 'obligation.completed' | 'obligation.waived'
  | 'approval.requested' | 'approval.decided'
  | 'audit.purged' | 'agent.run.started' | 'agent.run.completed' | 'agent.action.proposed'
  | 'clause.created' | 'clause.version.created' | 'clause.published' | 'clause.archived'
  | 'template.created' | 'template.version.created' | 'template.published' | 'template.archived' | 'template.instantiated'
  | 'playbook.created' | 'playbook.version.created' | 'playbook.published' | 'playbook.archived';

export interface AuditEntry {
  readonly id: AuditEventId; readonly tenantId: TenantId;
  readonly actorId: UserId | null; readonly action: AuditAction;
  readonly subjectType: string; readonly subjectId: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAt: string; readonly prevHash: string; readonly hash: string;
}

const GENESIS = 'GENESIS';
function hashOf(e: Omit<AuditEntry, 'id' | 'hash'>): string {
  return createHash('sha256').update(JSON.stringify([
    e.tenantId, e.actorId, e.action, e.subjectType, e.subjectId,
    e.detail, e.occurredAt, e.prevHash,
  ])).digest('hex');
}

export class AuditLog {
  #entries: AuditEntry[] = [];
  #holds = new Set<string>();
  readonly #clock: Clock;
  constructor(clock: Clock) { this.#clock = clock; }

  append(input: { tenantId: TenantId; actorId: UserId | null; action: AuditAction; subjectType: string; subjectId: string; detail?: Record<string, unknown> }): AuditEntry {
    const prev = this.#entries[this.#entries.length - 1];
    const base = {
      tenantId: input.tenantId, actorId: input.actorId, action: input.action,
      subjectType: input.subjectType, subjectId: input.subjectId,
      detail: Object.freeze({ ...(input.detail ?? {}) }),
      occurredAt: this.#clock.now().toISOString(), prevHash: prev ? prev.hash : GENESIS,
    };
    const entry: AuditEntry = Object.freeze({ id: newAuditEventId(), ...base, hash: hashOf(base) });
    this.#entries.push(entry);
    return entry;
  }
  list(tenantId: TenantId, filter: { subjectId?: string; action?: AuditAction } = {}): AuditEntry[] {
    return this.#entries.filter((e) => e.tenantId === tenantId
      && (filter.subjectId === undefined || e.subjectId === filter.subjectId)
      && (filter.action === undefined || e.action === filter.action));
  }
  verify(): boolean {
    let prevHash = GENESIS;
    for (const e of this.#entries) {
      if (e.prevHash !== prevHash) return false;
      const { id: _id, hash, ...rest } = e;
      if (hashOf(rest) !== hash) return false;
      prevHash = hash;
    }
    return true;
  }
  placeHold(subjectId: string): void { this.#holds.add(subjectId); }
  releaseHold(subjectId: string): void { this.#holds.delete(subjectId); }
  isHeld(subjectId: string): boolean { return this.#holds.has(subjectId); }
  purgeExpired(cutoffIso: string, tenantId: TenantId, actorId: UserId | null): number {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => !(e.tenantId === tenantId && e.occurredAt < cutoffIso && !this.#holds.has(e.subjectId)));
    const removed = before - this.#entries.length;
    if (removed > 0) this.append({ tenantId, actorId, action: 'audit.purged', subjectType: 'audit_log', subjectId: tenantId, detail: { removed, cutoffIso } });
    return removed;
  }
  get size(): number { return this.#entries.length; }
}

export function assertNotHeld(log: AuditLog, subjectId: string): void {
  if (log.isHeld(subjectId)) throw new DomainError('LEGAL_HOLD', `subject under legal hold: ${subjectId}`, { subjectId });
}
