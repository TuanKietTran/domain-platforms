import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/core/clock.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId, SequentialIdGenerator } from '../src/core/ids.js';
import { enrichContext, InMemoryCrmAdapter, InMemoryProductAdapter, IntegrationRegistry } from '../src/integrations/adapters.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const NOW = '2026-01-05T09:00:00.000Z';

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

function newCrm(): InMemoryCrmAdapter {
  return new InMemoryCrmAdapter('memory-crm', new SequentialIdGenerator(), new FakeClock(NOW));
}
function newProduct(): InMemoryProductAdapter {
  return new InMemoryProductAdapter('memory-product', new SequentialIdGenerator(), new FakeClock(NOW));
}

test('CRM upsert creates then updates in place, preserving the id and deduping tags', () => {
  const crm = newCrm();
  const created = crm.upsertCustomer({ tenantId: tenantA, externalId: 'ext-1', name: 'Sam', email: 'sam@example.com', tier: 'gold', tags: ['vip', 'vip', 'beta'] });
  assert.ok(created.id);
  assert.deepEqual(created.tags, ['vip', 'beta']);
  assert.equal(created.updatedAt, NOW);
  const updated = crm.upsertCustomer({ tenantId: tenantA, externalId: 'ext-1', name: 'Sam Lee', email: 'sam@example.com', tier: 'platinum' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'Sam Lee');
  assert.equal(updated.tier, 'platinum');
  assert.equal(crm.listCustomers(tenantA).length, 1);
  assert.equal(crm.findCustomer(tenantA, 'ext-1')?.name, 'Sam Lee');
});

test('CRM records are tenant-isolated and validated', () => {
  const crm = newCrm();
  crm.upsertCustomer({ tenantId: tenantA, externalId: 'ext-1', name: 'Sam' });
  crm.upsertCustomer({ tenantId: tenantB, externalId: 'ext-1', name: 'Other Tenant Sam' });
  assert.equal(crm.findCustomer(tenantA, 'ext-1')?.name, 'Sam');
  assert.equal(crm.findCustomer(tenantB, 'ext-1')?.name, 'Other Tenant Sam');
  assert.equal(crm.listCustomers(tenantA).length, 1);
  assert.equal(crm.findCustomer(tenantA, 'missing'), undefined);
  throwsCode(() => crm.upsertCustomer({ tenantId: tenantA, externalId: ' ', name: 'Sam' }), 'VALIDATION');
  throwsCode(() => crm.upsertCustomer({ tenantId: tenantA, externalId: 'ext-2', name: 'Sam', email: 'not-an-email' }), 'VALIDATION');
});

test('product upsert defaults to active, preserves id, validates status', () => {
  const product = newProduct();
  const created = product.upsertProduct({ tenantId: tenantA, sku: 'SKU-1', name: 'Widget', version: '1.0' });
  assert.equal(created.status, 'active');
  assert.equal(created.updatedAt, NOW);
  const updated = product.upsertProduct({ tenantId: tenantA, sku: 'SKU-1', name: 'Widget', version: '2.0', status: 'beta' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.status, 'beta');
  assert.equal(product.listProducts(tenantA).length, 1);
  assert.equal(product.findProduct(tenantB, 'SKU-1'), undefined);
  throwsCode(() => product.upsertProduct({ tenantId: tenantA, sku: 'SKU-2', name: 'Bad', status: 'weird' as 'active' }), 'VALIDATION');
});

test('registry routes by name, rejects duplicates and unknown adapters', () => {
  const registry = new IntegrationRegistry();
  const crm = newCrm();
  const product = newProduct();
  registry.registerCrm(crm);
  registry.registerProduct(product);
  assert.equal(registry.getCrm('memory-crm'), crm);
  assert.equal(registry.getProduct('memory-product'), product);
  assert.deepEqual(registry.crmNames(), ['memory-crm']);
  assert.deepEqual(registry.productNames(), ['memory-product']);
  throwsCode(() => registry.registerCrm(newCrm()), 'CONFLICT');
  throwsCode(() => registry.registerProduct(newProduct()), 'CONFLICT');
  throwsCode(() => registry.getCrm('salesforce'), 'NOT_FOUND');
  throwsCode(() => registry.getProduct('stripe'), 'NOT_FOUND');
});

test('enrichContext resolves refs through the ports and treats missing records as absent context', () => {
  const crm = newCrm();
  const product = newProduct();
  crm.upsertCustomer({ tenantId: tenantA, externalId: 'ext-1', name: 'Sam' });
  product.upsertProduct({ tenantId: tenantA, sku: 'SKU-1', name: 'Widget' });
  const full = enrichContext(crm, product, tenantA, { customerExternalId: 'ext-1', productSku: 'SKU-1' });
  assert.equal(full.customer?.name, 'Sam');
  assert.equal(full.product?.name, 'Widget');
  const partial = enrichContext(crm, product, tenantA, { customerExternalId: 'nope' });
  assert.equal(partial.customer, undefined);
  assert.equal(partial.product, undefined);
  const wrongTenant = enrichContext(crm, product, tenantB, { customerExternalId: 'ext-1', productSku: 'SKU-1' });
  assert.equal(wrongTenant.customer, undefined);
  assert.equal(wrongTenant.product, undefined);
});
