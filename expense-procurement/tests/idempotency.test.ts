import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DomainError } from '../src/core/errors.js';
import { IdempotencyRegistry, type IdempotentCommand } from '../src/core/idempotency.js';
import type { TenantId } from '../src/core/types.js';

const tenant = 'tenant-1' as TenantId;

function isCode(code: DomainError['code']) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

function makeCmd(request: unknown = { amount: 100 }, overrides: Partial<IdempotentCommand> = {}): IdempotentCommand {
  return { tenantId: tenant, operation: 'payments.create', key: 'key-1', request, ...overrides };
}

function assertFingerprintMismatch(first: unknown, second: unknown): void {
  const registry = new IdempotencyRegistry();
  let calls = 0;
  registry.execute(makeCmd(first), () => { calls += 1; return 'first'; });
  assert.throws(() => registry.execute(makeCmd(second), () => { calls += 1; return 'second'; }), isCode('IDEMPOTENCY_MISMATCH'));
  assert.equal(calls, 1);
}

describe('storage key (fix 1: delimiter collision)', () => {
  test('operations/keys containing colons do not collide', () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    const a = registry.execute(makeCmd({ v: 1 }, { operation: 'op:x', key: 'k' }), () => { calls += 1; return 'A'; });
    const b = registry.execute(makeCmd({ v: 1 }, { operation: 'op', key: 'x:k' }), () => { calls += 1; return 'B'; });
    assert.equal(a, 'A');
    assert.equal(b, 'B');
    assert.equal(calls, 2);
    assert.equal(registry.size(), 2);
  });

  test('tenants/operations containing colons do not collide', () => {
    const registry = new IdempotencyRegistry();
    const a = registry.execute(makeCmd({ v: 1 }, { tenantId: 't:x' as TenantId, operation: 'y', key: 'k' }), () => 'A');
    const b = registry.execute(makeCmd({ v: 1 }, { tenantId: 't' as TenantId, operation: 'x:y', key: 'k' }), () => 'B');
    assert.equal(a, 'A');
    assert.equal(b, 'B');
  });

  test('same key+request replays, different request is a mismatch, keys are trimmed', () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    const apply = () => { calls += 1; return { total: 100 }; };
    const first = registry.execute(makeCmd({ a: 1, b: 2 }), apply) as { total: number };
    const replay = registry.execute(makeCmd({ b: 2, a: 1 }, { key: ' key-1 ' }), apply) as { total: number };
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
    assert.equal(registry.get(tenant, 'payments.create', 'key-1')?.key, 'key-1');
    assert.throws(() => registry.execute(makeCmd({ a: 9 }), apply), isCode('IDEMPOTENCY_MISMATCH'));
    assert.equal(calls, 1);
  });
});

describe('validation (DomainError, never raw TypeError)', () => {
  test('blank or non-string key, tenant and operation are rejected everywhere', () => {
    const registry = new IdempotencyRegistry();
    for (const overrides of [{ key: ' ' }, { key: '' }, { operation: ' ' }, { tenantId: ' ' as TenantId }, { tenantId: '' as TenantId }]) {
      assert.throws(() => registry.execute(makeCmd({ v: 1 }, overrides), () => 'x'), isCode('VALIDATION'));
    }
    assert.throws(() => registry.execute({ ...makeCmd(), key: 42 as unknown as string }, () => 'x'), isCode('VALIDATION'));
    assert.throws(() => registry.has(tenant, 'payments.create', ' '), isCode('VALIDATION'));
    assert.throws(() => registry.get(tenant, ' ', 'key-1'), isCode('VALIDATION'));
    assert.equal(registry.size(), 0);
  });

  test('invalid clock and invalid registry options are DomainErrors raised before apply runs', () => {
    let calls = 0;
    const brokenClock = new IdempotencyRegistry(() => new Date('not-a-date'));
    assert.throws(() => brokenClock.execute(makeCmd(), () => { calls += 1; return 'x'; }), isCode('VALIDATION'));
    assert.equal(calls, 0);
    assert.throws(() => new IdempotencyRegistry({ maxRecords: 0 }), isCode('VALIDATION'));
    assert.throws(() => new IdempotencyRegistry({ ttlMs: -1 }), isCode('VALIDATION'));
    const fixed = new IdempotencyRegistry(() => new Date('2026-02-02T03:04:05.000Z'));
    fixed.execute(makeCmd(), () => 'x');
    assert.equal(fixed.get(tenant, 'payments.create', 'key-1')?.recordedAt, '2026-02-02T03:04:05.000Z');
  });
});

describe('request fingerprint (fix 3: no silent collisions, no raw crashes)', () => {
  test('Map, Set, Date-vs-string, undefined-vs-null, type and bigint differences all mismatch', () => {
    assertFingerprintMismatch(new Map([['a', 1]]), new Map([['b', 999]]));
    assertFingerprintMismatch(new Set([1]), new Set([2]));
    assertFingerprintMismatch({ at: new Date('2026-01-01T00:00:00.000Z') }, { at: '2026-01-01T00:00:00.000Z' });
    assertFingerprintMismatch([undefined], [null]);
    assertFingerprintMismatch({ a: undefined }, {});
    assertFingerprintMismatch({ n: 1 }, { n: '1' });
    assertFingerprintMismatch({ n: 10n }, { n: 10 });
    assertFingerprintMismatch(undefined, null);
  });

  test('equal Map/Set requests replay regardless of entry order', () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    const apply = () => { calls += 1; return 'ok'; };
    registry.execute(makeCmd(new Map([['a', 1], ['b', 2]])), apply);
    assert.equal(registry.execute(makeCmd(new Map([['b', 2], ['a', 1]])), apply), 'ok');
    registry.execute(makeCmd(new Set([1, 2]), { key: 'key-2' }), apply);
    assert.equal(registry.execute(makeCmd(new Set([2, 1]), { key: 'key-2' }), apply), 'ok');
    assert.equal(calls, 2);
  });

  test('cyclic, non-finite, function and class-instance requests are DomainErrors and never reach apply', () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    const apply = () => { calls += 1; return 'x'; };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class CustomRequest { constructor(readonly amount = 100) {} }
    for (const request of [cyclic, { amount: Number.POSITIVE_INFINITY }, { fn: () => 1 }, new CustomRequest(), { amount: Number.NaN }]) {
      assert.throws(() => registry.execute(makeCmd(request), apply), isCode('VALIDATION'));
    }
    assert.equal(calls, 0);
    assert.equal(registry.size(), 0);
  });

  test('a top-level undefined request fingerprints instead of crashing', () => {
    const registry = new IdempotencyRegistry();
    assert.equal(registry.execute(makeCmd(undefined), () => 'ok'), 'ok');
    assert.equal(registry.execute(makeCmd(undefined), () => 'other'), 'ok');
  });
});
describe('async commands (fix 2: executeAsync, in-flight dedup)', () => {
  test('concurrent executeAsync calls share one apply; a sync call during flight conflicts; replay reuses the result', async () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    let release!: (value: { total: number }) => void;
    const apply = () => { calls += 1; return new Promise<{ total: number }>((resolve) => { release = resolve; }); };
    const p1 = registry.executeAsync(makeCmd(), apply);
    const p2 = registry.executeAsync(makeCmd(), apply);
    assert.equal(calls, 1);
    assert.throws(() => registry.execute(makeCmd(), () => ({ total: 0 })), isCode('CONFLICT'));
    release({ total: 7 });
    const [a, b] = await Promise.all([p1, p2]);
    assert.deepEqual(a, { total: 7 });
    assert.deepEqual(b, { total: 7 });
    assert.notEqual(a, b);
    assert.deepEqual(await registry.executeAsync(makeCmd(), apply), { total: 7 });
    assert.equal(calls, 1);
  });

  test('executeAsync with a different request while in flight is a mismatch', async () => {
    const registry = new IdempotencyRegistry();
    let release!: (value: string) => void;
    const p1 = registry.executeAsync(makeCmd({ v: 1 }), () => new Promise<string>((resolve) => { release = resolve; }));
    await assert.rejects(registry.executeAsync(makeCmd({ v: 2 }), async () => 'other'), isCode('IDEMPOTENCY_MISMATCH'));
    release('done');
    assert.equal(await p1, 'done');
  });

  test('a rejected async apply stores nothing and can be retried; async validation rejects as DomainError', async () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    await assert.rejects(registry.executeAsync(makeCmd(), async () => { calls += 1; throw new Error('boom'); }), /boom/);
    assert.equal(registry.has(tenant, 'payments.create', 'key-1'), false);
    assert.equal(await registry.executeAsync(makeCmd(), async () => { calls += 1; return 'ok'; }), 'ok');
    assert.equal(calls, 2);
    await assert.rejects(registry.executeAsync(makeCmd({ v: 1 }, { key: ' ' }), async () => 'x'), isCode('VALIDATION'));
  });

  test('sync execute rejects a Promise result as UNSUPPORTED instead of a DataCloneError, and stores nothing', () => {
    const registry = new IdempotencyRegistry();
    assert.throws(() => registry.execute(makeCmd(), () => Promise.resolve('x') as unknown as string), isCode('UNSUPPORTED'));
    assert.equal(registry.has(tenant, 'payments.create', 'key-1'), false);
    assert.equal(registry.size(), 0);
  });
});

describe('stored results (deep-clone, deep-freeze, no prototype loss by stealth)', () => {
  test('mutating the returned value or the original object does not change the replay', () => {
    const registry = new IdempotencyRegistry();
    const original = { total: 100, nested: { fee: 3 } };
    const first = registry.execute(makeCmd(), () => original) as { total: number; nested: { fee: number } };
    first.total = 1;
    original.nested.fee = 99;
    const replay = registry.execute(makeCmd(), () => ({ total: 0, nested: { fee: 0 } })) as { total: number; nested: { fee: number } };
    assert.deepEqual(replay, { total: 100, nested: { fee: 3 } });
    assert.notEqual(replay, first);
  });

  test('get returns a deep-frozen copy: mutating it cannot corrupt the stored result', () => {
    const registry = new IdempotencyRegistry();
    registry.execute(makeCmd(), () => ({ total: 100, nested: { fee: 3 } }));
    const record = registry.get<{ total: number; nested: { fee: number } }>(tenant, 'payments.create', 'key-1');
    assert.ok(record);
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.result), true);
    assert.equal(Object.isFrozen(record.result.nested), true);
    assert.throws(() => { record.result.total = 0; });
    assert.deepEqual(registry.execute(makeCmd(), () => ({ total: 0, nested: { fee: 0 } })), { total: 100, nested: { fee: 3 } });
    assert.equal(registry.get(tenant, 'payments.create', 'missing'), undefined);
    assert.equal(registry.has(tenant, 'payments.create', 'missing'), false);
  });

  test('class-instance results are rejected as UNSUPPORTED; Date results keep their prototype on replay', () => {
    class Money { constructor(readonly cents: number) {} }
    const registry = new IdempotencyRegistry();
    assert.throws(() => registry.execute(makeCmd(), () => new Money(100) as unknown as { cents: number }), isCode('UNSUPPORTED'));
    assert.equal(registry.has(tenant, 'payments.create', 'key-1'), false);
    const at = new Date('2026-03-03T00:00:00.000Z');
    registry.execute(makeCmd('req', { key: 'key-date' }), () => at);
    const replay = registry.execute(makeCmd('req', { key: 'key-date' }), () => new Date(0)) as Date;
    assert.ok(replay instanceof Date);
    assert.equal(replay.toISOString(), at.toISOString());
  });
});

describe('retention (bounded, TTL, clear)', () => {
  test('records expire after ttlMs and may be applied again', () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const registry = new IdempotencyRegistry({ now: () => new Date(nowMs), ttlMs: 1000 });
    let calls = 0;
    const apply = () => { calls += 1; return calls; };
    assert.equal(registry.execute(makeCmd(), apply), 1);
    assert.equal(registry.execute(makeCmd(), apply), 1);
    nowMs += 1001;
    assert.equal(registry.execute(makeCmd(), apply), 2);
    assert.equal(calls, 2);
  });

  test('maxRecords evicts the oldest record; clear empties the registry', () => {
    const registry = new IdempotencyRegistry({ maxRecords: 2 });
    for (const key of ['a', 'b', 'c']) registry.execute(makeCmd({ v: key }, { key }), () => key);
    assert.equal(registry.size(), 2);
    assert.equal(registry.has(tenant, 'payments.create', 'a'), false);
    assert.equal(registry.has(tenant, 'payments.create', 'c'), true);
    let calls = 0;
    registry.clear();
    assert.equal(registry.size(), 0);
    registry.execute(makeCmd({ v: 'a' }, { key: 'a' }), () => { calls += 1; return 'a'; });
    assert.equal(calls, 1);
  });
});
