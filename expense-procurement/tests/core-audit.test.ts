import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, hashAuditEntry, verifyAuditEntries, type AuditEntry, type AuditEntryInput } from '../src/core/audit.js';
import { DomainError } from '../src/core/errors.js';
import { userActor } from '../src/core/events.js';
import { tenantId, userId, type TenantId } from '../src/core/types.js';

const GENESIS = '0'.repeat(64);
const t1 = tenantId('tenant_1');
const t2 = tenantId('tenant_2');
const actor = userActor(userId('user_1'));
const isDomain = (code: string) => (err: unknown) => err instanceof DomainError && err.code === code;

function makeLog(): AuditLog {
  let n = 0;
  return new AuditLog({ now: () => new Date('2026-01-01T00:00:00.000Z'), nextId: () => `aud_${++n}` });
}

function input(tenant: TenantId, action: string, extra: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    tenantId: tenant,
    action,
    actor,
    subject: { type: 'expense_report', id: 'exp_1' },
    outcome: 'recorded',
    correlationId: 'corr_1',
    ...extra,
  };
}

/** The internal array, reached only so tests can simulate tampering with stored records. */
function internal(log: AuditLog): AuditEntry[] {
  return (log as unknown as { entries: AuditEntry[] }).entries;
}

describe('AuditLog.append (per-tenant hash chain)', () => {
  it('assigns per-tenant sequences starting at 1, chained from GENESIS', () => {
    const log = makeLog();
    const a1 = log.append(input(t1, 'expense.submitted'));
    const b1 = log.append(input(t2, 'expense.submitted'));
    const a2 = log.append(input(t1, 'expense.approved'));
    assert.equal(a1.sequence, 1);
    assert.equal(b1.sequence, 1);
    assert.equal(a2.sequence, 2);
    assert.equal(a1.previousHash, GENESIS);
    assert.equal(b1.previousHash, GENESIS);
    assert.equal(a2.previousHash, a1.hash);
    assert.match(a1.hash, /^[0-9a-f]{64}$/);
    assert.equal(log.size(), 3);
  });

  it('hashes deterministically: identical inputs, clock and ids give identical hashes', () => {
    const left = makeLog();
    const right = makeLog();
    for (const log of [left, right]) {
      log.append(input(t1, 'expense.submitted', { details: { amount: 100 } }));
      log.append(input(t1, 'expense.approved'));
    }
    assert.deepEqual(left.list(t1), right.list(t1));
  });

  it('rejects an empty action or correlation id', () => {
    const log = makeLog();
    assert.throws(() => log.append(input(t1, '  ')), isDomain('VALIDATION'));
    assert.throws(() => log.append(input(t1, 'expense.submitted', { correlationId: '' })), isDomain('VALIDATION'));
    assert.equal(log.size(), 0);
  });

  it('freezes entries and snapshots details instead of aliasing the caller object', () => {
    const log = makeLog();
    const details = { nested: { amount: 100 } };
    const entry = log.append(input(t1, 'expense.submitted', { details }));
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.details));
    assert.equal(Object.isFrozen(details), false);
    details.nested.amount = 200;
    assert.equal((entry.details as { nested: { amount: number } }).nested.amount, 100);
  });

  it('get, list filters and size', () => {
    const log = makeLog();
    const a1 = log.append(input(t1, 'expense.submitted'));
    log.append(input(t1, 'expense.approved', { subject: { type: 'expense_report', id: 'exp_2' } }));
    log.append(input(t2, 'expense.submitted'));
    assert.equal(log.get(a1.auditId), a1);
    assert.equal(log.get('missing'), undefined);
    assert.equal(log.list(t1).length, 2);
    assert.equal(log.list(t1, { action: 'expense.approved' }).length, 1);
    assert.equal(log.list(t1, { subjectId: 'exp_2' }).length, 1);
    assert.equal(log.list(t1, { subjectType: 'invoice' }).length, 0);
    const listed = log.list(t1) as AuditEntry[];
    listed.pop();
    assert.equal(log.list(t1).length, 2);
  });
});

describe('AuditLog.verify', () => {
  it('validates a single-tenant trail and an empty log / unknown tenant', () => {
    const log = makeLog();
    assert.deepEqual(log.verify(), { valid: true, entries: 0 });
    assert.deepEqual(log.verify(t1), { valid: true, entries: 0 });
    log.append(input(t1, 'a'));
    log.append(input(t1, 'b'));
    assert.deepEqual(log.verify(), { valid: true, entries: 2 });
    assert.deepEqual(log.verify(tenantId('never_seen')), { valid: true, entries: 0 });
  });

  it('validates interleaved multi-tenant trails, globally and per tenant', () => {
    const log = makeLog();
    log.append(input(t1, 'a1'));
    log.append(input(t2, 'b1'));
    log.append(input(t1, 'a2'));
    log.append(input(t2, 'b2'));
    assert.deepEqual(log.verify(), { valid: true, entries: 4 });
    assert.deepEqual(log.verify(t1), { valid: true, entries: 2 });
    assert.deepEqual(log.verify(t2), { valid: true, entries: 2 });
  });

  it('detects an edited entry by its hash', () => {
    const log = makeLog();
    log.append(input(t1, 'a', { details: { amount: 100 } }));
    log.append(input(t1, 'b'));
    const stored = internal(log);
    stored[0] = { ...stored[0]!, details: { amount: 999 } };
    const result = log.verify(t1);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt?.reason, 'entry hash mismatch');
    assert.equal(result.brokenAt?.auditId, stored[0]!.auditId);
  });

  it('detects a deleted middle entry and a reordering', () => {
    const log = makeLog();
    log.append(input(t1, 'a'));
    log.append(input(t1, 'b'));
    log.append(input(t1, 'c'));
    internal(log).splice(1, 1);
    const deleted = log.verify(t1);
    assert.equal(deleted.valid, false);
    assert.equal(deleted.brokenAt?.reason, 'previous hash mismatch');
    assert.equal(deleted.brokenAt?.sequence, 3);

    const reordered = makeLog();
    reordered.append(input(t1, 'a'));
    reordered.append(input(t1, 'b'));
    const stored = internal(reordered);
    [stored[0], stored[1]] = [stored[1]!, stored[0]!];
    assert.equal(reordered.verify(t1).valid, false);
  });

  it('detects trailing truncation via the append-time head', () => {
    const log = makeLog();
    log.append(input(t1, 'a1'));
    log.append(input(t2, 'b1'));
    const dropped = log.append(input(t2, 'b2'));
    internal(log).pop();
    for (const result of [log.verify(t2), log.verify()]) {
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt?.reason, 'audit head mismatch');
      assert.equal(result.brokenAt?.auditId, dropped.auditId);
      assert.equal(result.brokenAt?.sequence, dropped.sequence);
    }
    assert.deepEqual(log.verify(t1), { valid: true, entries: 1 });
  });

  it('detects dropping a tenant trail entirely', () => {
    const log = makeLog();
    log.append(input(t1, 'a1'));
    const b1 = log.append(input(t2, 'b1'));
    log.append(input(t1, 'a2'));
    log.append(input(t2, 'b2'));
    const stored = internal(log);
    for (let i = stored.length - 1; i >= 0; i--) if (stored[i]!.tenantId === t2) stored.splice(i, 1);
    assert.equal(log.verify().valid, false);
    const perTenant = log.verify(t2);
    assert.equal(perTenant.valid, false);
    assert.equal(perTenant.brokenAt?.reason, 'audit head mismatch');
    assert.equal(perTenant.brokenAt?.sequence, 2);
    assert.notEqual(perTenant.brokenAt?.auditId, b1.auditId);
    assert.deepEqual(log.verify(t1), { valid: true, entries: 2 });
  });
});

describe('verifyAuditEntries (standalone, exported trails)', () => {
  it('validates exported trails, including two tenants interleaved', () => {
    const log = makeLog();
    log.append(input(t1, 'a1'));
    log.append(input(t2, 'b1'));
    log.append(input(t1, 'a2'));
    log.append(input(t2, 'b2'));
    const e1 = log.export(t1).entries;
    const e2 = log.export(t2).entries;
    assert.deepEqual(verifyAuditEntries([]), { valid: true, entries: 0 });
    assert.deepEqual(verifyAuditEntries(e1), { valid: true, entries: 2 });
    assert.deepEqual(verifyAuditEntries([e1[0]!, e2[0]!, e1[1]!, e2[1]!]), { valid: true, entries: 4 });
  });

  it('detects tampering, deletion and reordering in exported entries', () => {
    const log = makeLog();
    log.append(input(t1, 'a'));
    log.append(input(t1, 'b'));
    log.append(input(t1, 'c'));
    const exported = log.export(t1).entries;
    const tampered = exported.map((entry, i) => (i === 1 ? { ...entry, action: 'expense.deleted' } : entry));
    assert.equal(verifyAuditEntries(tampered).brokenAt?.reason, 'entry hash mismatch');
    assert.equal(verifyAuditEntries([exported[0]!, exported[2]!]).brokenAt?.reason, 'previous hash mismatch');
    assert.equal(verifyAuditEntries([exported[1]!, exported[0]!, exported[2]!]).valid, false);
  });

  it('detects a sequence gap even when the hash was recomputed', () => {
    const log = makeLog();
    const first = log.append(input(t1, 'a'));
    const second = log.append(input(t1, 'b'));
    const { hash: _ignored, ...rest } = { ...second, sequence: 5 };
    void _ignored;
    const forged: AuditEntry = { ...rest, hash: hashAuditEntry(rest) };
    const result = verifyAuditEntries([first, forged]);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt?.reason, 'sequence gap');
    assert.equal(result.brokenAt?.sequence, 5);
  });
});

describe('AuditLog.export', () => {
  it('returns the tenant trail with its head, GENESIS for an empty trail', () => {
    const log = makeLog();
    assert.deepEqual(log.export(t1), { entries: [], head: GENESIS });
    log.append(input(t1, 'a'));
    const last = log.append(input(t2, 'b'));
    const exported = log.export(t2);
    assert.equal(exported.entries.length, 1);
    assert.equal(exported.head, last.hash);
    assert.equal(exported.head, exported.entries.at(-1)?.hash);
  });
});
