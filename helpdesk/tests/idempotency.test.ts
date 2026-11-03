import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IdempotencyStore } from '../src/core/idempotency.js';
import { asTenantId } from '../src/core/ids.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const now = () => '2026-01-05T09:00:00.000Z';

test('a repeated key with the same fingerprint replays without re-running', async () => {
  const store = new IdempotencyStore(now);
  let executions = 0;
  const operation = () => {
    executions += 1;
    return { ticket: 'tkt_1' };
  };
  const first = await store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, operation);
  const second = await store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, operation);
  assert.equal(executions, 1);
  assert.equal(second, first);
  assert.equal(store.has(tenantA, 'k1'), true);
});

test('the same key under a different tenant is independent', async () => {
  const store = new IdempotencyStore(now);
  let executions = 0;
  const operation = () => {
    executions += 1;
    return executions;
  };
  await store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, operation);
  const other = await store.run({ tenantId: tenantB, key: 'k1', fingerprint: 'fp-a' }, operation);
  assert.equal(other, 2);
});

test('reusing a key with a different payload is rejected', async () => {
  const store = new IdempotencyStore(now);
  await store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, () => 'first');
  await assert.rejects(
    store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-b' }, () => 'second'),
    /Idempotency key reused with a different payload/,
  );
});

test('concurrent callers with the same key share one execution', async () => {
  const store = new IdempotencyStore(now);
  let executions = 0;
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const operation = () => {
    executions += 1;
    return gate;
  };
  const first = store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, operation);
  const second = store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, operation);
  release('shared');
  assert.equal(await first, 'shared');
  assert.equal(await second, 'shared');
  assert.equal(executions, 1);
});

test('a concurrent caller with the same key but a different payload is rejected, not replayed', async () => {
  const store = new IdempotencyStore(now);
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const first = store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, () => gate);
  const second = store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-b' }, () => 'other');
  const secondAssertion = assert.rejects(second, /Idempotency key reused with a different payload/);
  release('result-a');
  assert.equal(await first, 'result-a');
  await secondAssertion;
});

test('a failed operation is not cached, so a retry with the same key can succeed', async () => {
  const store = new IdempotencyStore(now);
  await assert.rejects(
    store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const retried = await store.run({ tenantId: tenantA, key: 'k1', fingerprint: 'fp-a' }, () => 'recovered');
  assert.equal(retried, 'recovered');
});

test('without a key the operation always runs', async () => {
  const store = new IdempotencyStore(now);
  let executions = 0;
  const operation = () => {
    executions += 1;
    return executions;
  };
  await store.run({ tenantId: tenantA, fingerprint: 'fp-a' }, operation);
  await store.run({ tenantId: tenantA, fingerprint: 'fp-a' }, operation);
  assert.equal(executions, 2);
});
