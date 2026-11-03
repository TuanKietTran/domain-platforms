import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { contextFor, requirePermission } from '../src/identity/index.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

test('role bundles expand to permissions', () => {
  const w = makeWorld();
  assert.ok(w.adminCtx.permissions.has('admin:users'));
  assert.ok(!w.viewerCtx.permissions.has('contract:write'));
  assert.throws(() => requirePermission(w.viewerCtx, 'contract:write'), isCode('FORBIDDEN'));
});

test('cross-tenant contract access is denied even for an admin of another tenant', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  assert.throws(() => w.contracts.get(w.outsiderCtx, c.id), isCode('TENANT_MISMATCH'));
  assert.equal(w.contracts.list(w.outsiderCtx).length, 0);
});

test('duplicate email within a tenant conflicts; same email in another tenant is fine', () => {
  const w = makeWorld();
  assert.throws(() => w.directory.createUser(w.tenant.id, 'admin@acme.test', 'Dup', ['viewer']), isCode('CONFLICT'));
  const u = w.directory.createUser(w.otherTenant.id, 'admin@acme.test', 'Fine', ['viewer']);
  assert.equal(u.tenantId, w.otherTenant.id);
});

test('contextFor carries the user tenant and id', () => {
  const w = makeWorld();
  const ctx = contextFor(w.counsel);
  assert.equal(ctx.tenantId, w.tenant.id);
  assert.equal(ctx.userId, w.counsel.id);
});
