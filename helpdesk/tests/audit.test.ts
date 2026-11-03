import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditLog, verifyAuditEntries, type AuditEntry } from '../src/core/audit.js';
import { FakeClock } from '../src/core/clock.js';
import { fingerprint } from '../src/core/idempotency.js';
import { asTenantId, SequentialIdGenerator, type TenantId } from '../src/core/ids.js';
import { canonicalJson } from '../src/core/util.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const actor = { kind: 'user' as const, id: 'usr_1' };

function newLog(): AuditLog {
  return new AuditLog(new FakeClock('2026-01-05T09:00:00.000Z'), new SequentialIdGenerator());
}

function append(log: AuditLog, tenantId: TenantId = tenantA, summary = 'did a thing'): AuditEntry {
  return log.append({
    tenantId,
    actor,
    action: 'ticket.create',
    subjectType: 'ticket',
    subjectId: 'tkt_1',
    outcome: 'succeeded',
    summary,
  });
}

test('append builds independent per-tenant hash chains that verify', () => {
  const log = newLog();
  const a1 = append(log, tenantA, 'a1');
  const b1 = append(log, tenantB, 'b1');
  const a2 = append(log, tenantA, 'a2');
  assert.equal(a1.sequence, 1);
  assert.equal(b1.sequence, 1);
  assert.equal(a2.sequence, 2);
  assert.equal(a2.previousHash, a1.hash);
  assert.equal(b1.previousHash, '0'.repeat(64));
  assert.deepEqual(log.verify(), { valid: true, checked: 3 });
  assert.deepEqual(log.verify(tenantA), { valid: true, checked: 2 });
  assert.deepEqual(verifyAuditEntries(log.exportEntries()), { valid: true, checked: 3 });
});

test('verifyAuditEntries detects an edited entry', () => {
  const log = newLog();
  append(log);
  append(log);
  const exported = log.exportEntries().map((entry) => ({ ...entry }));
  exported[0] = { ...exported[0], summary: 'forged' } as AuditEntry;
  const result = verifyAuditEntries(exported);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt?.reason, 'entry hash mismatch');
});

test('verifyAuditEntries detects a removed middle entry', () => {
  const log = newLog();
  append(log);
  append(log);
  append(log);
  const exported = log.exportEntries();
  const result = verifyAuditEntries([exported[0] as AuditEntry, exported[2] as AuditEntry]);
  assert.equal(result.valid, false);
});

test('verifyAuditEntries detects reordered entries', () => {
  const log = newLog();
  append(log);
  append(log);
  const exported = log.exportEntries();
  const result = verifyAuditEntries([exported[1] as AuditEntry, exported[0] as AuditEntry]);
  assert.equal(result.valid, false);
});

test('append clones caller-owned actor and metadata instead of freezing them', () => {
  const log = newLog();
  const metadata: Record<string, unknown> = { attempts: 1, nested: { ok: true } };
  const callerActor = { kind: 'user' as const, id: 'usr_9' };
  const entry = log.append({
    tenantId: tenantA,
    actor: callerActor,
    action: 'ticket.update',
    subjectType: 'ticket',
    subjectId: 'tkt_2',
    outcome: 'succeeded',
    summary: 'updated',
    metadata,
  });
  assert.equal(Object.isFrozen(metadata), false);
  assert.equal(Object.isFrozen(callerActor), false);
  metadata.attempts = 99;
  (metadata.nested as { ok: boolean }).ok = false;
  assert.deepEqual(entry.metadata, { attempts: 1, nested: { ok: true } });
  assert.equal(log.verify().valid, true);
});

test('AuditLog.verify anchors to the append-time head, so dropped trailing entries are detected', () => {
  const log = newLog();
  append(log);
  append(log);
  const internals = log as unknown as { entries: AuditEntry[] };
  internals.entries.pop();
  const result = log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt?.reason, 'audit head mismatch');
});

test('AuditLog.verify detects dropping every entry, not just a trailing one', () => {
  const log = newLog();
  append(log);
  append(log);
  const internals = log as unknown as { entries: AuditEntry[] };
  internals.entries.length = 0;
  const result = log.verify();
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt?.reason, 'audit head mismatch');
  assert.equal(log.verify(tenantA).valid, false);
});

test('AuditLog.verify detects dropping all entries for one tenant while another remains', () => {
  const log = newLog();
  append(log, tenantA, 'a1');
  append(log, tenantB, 'b1');
  const internals = log as unknown as { entries: AuditEntry[] };
  const idx = internals.entries.findIndex((e) => e.tenantId === tenantB);
  internals.entries.splice(idx, 1);
  assert.equal(log.verify().valid, false);
  assert.equal(log.verify(tenantB).valid, false);
  assert.equal(log.verify(tenantA).valid, true);
});

test('canonicalJson distinguishes Date values so hashes cannot collide across instants', () => {
  const a = fingerprint({ at: new Date('2026-01-01T00:00:00.000Z') });
  const b = fingerprint({ at: new Date('2026-01-02T00:00:00.000Z') });
  assert.notEqual(a, b);
  assert.equal(
    canonicalJson({ at: new Date('2026-01-01T00:00:00.000Z') }),
    canonicalJson({ at: new Date('2026-01-01T00:00:00.000Z') }),
  );
});
