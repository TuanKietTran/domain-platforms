import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/events.ts';
import { FakeClock } from '../src/core/clock.ts';
import { kindOf, newContractId, newTenantId } from '../src/core/ids.ts';
import { makeWorld } from './helpers.ts';

test('ids are prefixed and kind-detectable', () => {
  assert.equal(kindOf(newContractId()), 'contract');
  assert.equal(kindOf(newTenantId()), 'tenant');
  assert.equal(kindOf('bogus'), null);
});

test('FakeClock advances deterministically', () => {
  const c = new FakeClock('2026-01-01T00:00:00.000Z');
  c.advanceDays(2);
  assert.equal(c.now().toISOString(), '2026-01-03T00:00:00.000Z');
});

test('event bus delivers, isolates subscriber failures, records history', async () => {
  const w = makeWorld();
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on('contract.created', (e) => { seen.push(e.type); });
  bus.on('contract.created', () => { throw new Error('boom'); });
  await bus.publish({ type: 'contract.created', tenantId: w.tenant.id, actorId: w.admin.id, occurredAt: w.clock.now().toISOString(), payload: {} });
  assert.deepEqual(seen, ['contract.created']);
  assert.equal(bus.history.length, 1);
  assert.equal(bus.drainErrors().length, 1);
  assert.equal(bus.drainErrors().length, 0);
});
