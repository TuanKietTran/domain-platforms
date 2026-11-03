import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DomainError } from '../src/core/errors.js';
import { asTenantId, SequentialIdGenerator } from '../src/core/ids.js';
import {
  ALL_PERMISSIONS,
  IdentityService,
  ROLE_PERMISSIONS,
  assertTenant,
  authorize,
  hasPermission,
  principalFromUser,
  roleOf,
  type Tenant,
  type User,
} from '../src/core/tenancy.js';

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

function newService(): IdentityService {
  return new IdentityService(new SequentialIdGenerator());
}

test('createTenant trims the name, applies defaults and stamps the epoch creation time', () => {
  const svc = newService();
  const t = svc.createTenant({ name: '  Acme Support  ' });
  assert.equal(t.id, 'ten_000001');
  assert.equal(t.name, 'Acme Support');
  assert.equal(t.plan, 'standard');
  assert.equal(t.status, 'active');
  assert.equal(t.retentionDays, 365);
  assert.equal(t.createdAt, new Date(0).toISOString());
  const t2 = svc.createTenant({ name: 'Beta', plan: 'enterprise', retentionDays: 30 });
  assert.equal(t2.id, 'ten_000002');
  assert.equal(t2.plan, 'enterprise');
  assert.equal(t2.retentionDays, 30);
  assert.equal(svc.getTenant(t.id), t);
});

test('createTenant rejects names shorter than two characters after trimming', () => {
  const svc = newService();
  throwsCode(() => svc.createTenant({ name: ' x ' }), 'VALIDATION');
  throwsCode(() => svc.createTenant({ name: '   ' }), 'VALIDATION');
});

test('getTenant and getUser throw NOT_FOUND for unknown ids', () => {
  const svc = newService();
  throwsCode(() => svc.getTenant(asTenantId('tenant-missing')), 'NOT_FOUND');
  throwsCode(() => svc.getUser('usr_missing' as User['id']), 'NOT_FOUND');
});

test('createUser normalizes email, dedupes roles and teams, and falls back to email for a blank name', () => {
  const svc = newService();
  const t = svc.createTenant({ name: 'Acme' });
  const u = svc.createUser({
    tenantId: t.id,
    email: '  Ana@Example.COM ',
    displayName: '   ',
    roles: ['agent', 'agent'],
    teamIds: ['team-1' as User['teamIds'][number], 'team-1' as User['teamIds'][number]],
  });
  assert.equal(u.id, 'usr_000001');
  assert.equal(u.email, 'ana@example.com');
  assert.equal(u.displayName, 'ana@example.com');
  assert.deepEqual(u.roles, ['agent']);
  assert.deepEqual(u.teamIds, ['team-1']);
  assert.equal(u.status, 'active');
  const named = svc.createUser({ tenantId: t.id, email: 'bo@example.com', displayName: '  Bo Lee ', roles: ['requester'] });
  assert.equal(named.displayName, 'Bo Lee');
  assert.deepEqual(named.teamIds, []);
});

test('createUser validates tenant existence, email shape and non-empty roles', () => {
  const svc = newService();
  const t = svc.createTenant({ name: 'Acme' });
  throwsCode(() => svc.createUser({ tenantId: asTenantId('nope'), email: 'a@b.co', displayName: 'A', roles: ['agent'] }), 'NOT_FOUND');
  throwsCode(() => svc.createUser({ tenantId: t.id, email: 'not-an-email', displayName: 'A', roles: ['agent'] }), 'VALIDATION');
  throwsCode(() => svc.createUser({ tenantId: t.id, email: 'a@b', displayName: 'A', roles: ['agent'] }), 'VALIDATION');
  throwsCode(() => svc.createUser({ tenantId: t.id, email: 'a@b.co', displayName: 'A', roles: [] }), 'VALIDATION');
});

test('createUser rejects a duplicate email within a tenant but allows it in another tenant', () => {
  const svc = newService();
  const a = svc.createTenant({ name: 'Acme' });
  const b = svc.createTenant({ name: 'Beta' });
  svc.createUser({ tenantId: a.id, email: 'sam@example.com', displayName: 'Sam', roles: ['agent'] });
  throwsCode(() => svc.createUser({ tenantId: a.id, email: 'SAM@example.com', displayName: 'Sam 2', roles: ['agent'] }), 'CONFLICT');
  const other = svc.createUser({ tenantId: b.id, email: 'sam@example.com', displayName: 'Sam', roles: ['agent'] });
  assert.equal(other.tenantId, b.id);
  assert.deepEqual(svc.listUsers(a.id).map((u) => u.email), ['sam@example.com']);
  assert.deepEqual(svc.listUsers(b.id).map((u) => u.email), ['sam@example.com']);
  assert.deepEqual(svc.listUsers(asTenantId('empty')), []);
});

test('a suspended tenant blocks createUser and a suspended user blocks principalFor', () => {
  const svc = newService();
  const t = svc.createTenant({ name: 'Acme' });
  const u = svc.createUser({ tenantId: t.id, email: 'ana@example.com', displayName: 'Ana', roles: ['agent'] });
  const tenants = (svc as unknown as { tenants: Map<string, Tenant> }).tenants;
  tenants.set(t.id, { ...t, status: 'suspended' });
  throwsCode(() => svc.createUser({ tenantId: t.id, email: 'bo@example.com', displayName: 'Bo', roles: ['agent'] }), 'FORBIDDEN');
  const users = (svc as unknown as { users: Map<string, User> }).users;
  users.set(u.id, { ...u, status: 'suspended' });
  throwsCode(() => svc.principalFor(u.id), 'FORBIDDEN');
});

test('principalFor unions permissions across all of the user roles', () => {
  const svc = newService();
  const t = svc.createTenant({ name: 'Acme' });
  const u = svc.createUser({ tenantId: t.id, email: 'ana@example.com', displayName: 'Ana', roles: ['requester', 'auditor'] });
  const p = svc.principalFor(u.id);
  assert.equal(p.userId, u.id);
  assert.equal(p.tenantId, t.id);
  assert.deepEqual(p.roles, ['requester', 'auditor']);
  assert.ok(p.permissions instanceof Set);
  assert.ok(hasPermission(p, 'ticket:create'));
  assert.ok(hasPermission(p, 'audit:read'));
  assert.equal(hasPermission(p, 'ticket:assign'), false);
  assert.ok(roleOf(p, 'auditor'));
  assert.equal(roleOf(p, 'admin'), false);
});

test('principalFromUser builds the same union directly from a user record', () => {
  const svc = newService();
  const t = svc.createTenant({ name: 'Acme' });
  const u = svc.createUser({ tenantId: t.id, email: 'ana@example.com', displayName: 'Ana', roles: ['integration'] });
  const p = principalFromUser(u);
  assert.ok(hasPermission(p, 'integration:manage'));
  assert.equal(hasPermission(p, 'ticket:close'), false);
});

test('ROLE_PERMISSIONS encodes the role matrix', () => {
  assert.deepEqual(ROLE_PERMISSIONS.requester, ['ticket:read', 'ticket:create', 'ticket:message', 'knowledge:read']);
  assert.deepEqual(ROLE_PERMISSIONS.auditor, ['ticket:read', 'knowledge:read', 'audit:read', 'analytics:read']);
  assert.deepEqual(ROLE_PERMISSIONS.admin, ALL_PERMISSIONS);
  assert.deepEqual(ROLE_PERMISSIONS.system, ALL_PERMISSIONS);
  for (const extra of ['harness:approve', 'quality:write', 'knowledge:publish', 'customer:write', 'notification:manage'] as const) {
    assert.ok(ROLE_PERMISSIONS.team_lead.includes(extra), extra);
    assert.equal(ROLE_PERMISSIONS.agent.includes(extra), false, extra);
  }
  assert.ok(ROLE_PERMISSIONS.agent.includes('ticket:assign'));
  assert.equal(ROLE_PERMISSIONS.team_lead.includes('audit:read'), false);
  assert.equal(ROLE_PERMISSIONS.team_lead.includes('settings:write'), false);
  assert.ok(ROLE_PERMISSIONS.integration.includes('integration:manage'));
  assert.equal(ROLE_PERMISSIONS.integration.includes('ticket:assign'), false);
});

test('systemPrincipal carries the system role and every permission for the given tenant', () => {
  const svc = newService();
  const t = svc.createTenant({ name: 'Acme' });
  const p = svc.systemPrincipal(t.id);
  assert.equal(p.userId, 'usr_system');
  assert.equal(p.tenantId, t.id);
  assert.deepEqual(p.roles, ['system']);
  for (const permission of ALL_PERMISSIONS) assert.ok(hasPermission(p, permission), permission);
});

test('assertTenant and authorize enforce tenant match before permission', () => {
  const svc = newService();
  const a = svc.createTenant({ name: 'Acme' });
  const b = svc.createTenant({ name: 'Beta' });
  const u = svc.createUser({ tenantId: a.id, email: 'ana@example.com', displayName: 'Ana', roles: ['auditor'] });
  const p = svc.principalFor(u.id);
  assert.doesNotThrow(() => assertTenant(p, a.id));
  throwsCode(() => assertTenant(p, b.id), 'TENANT_MISMATCH');
  assert.doesNotThrow(() => authorize(p, 'audit:read', a.id));
  assert.doesNotThrow(() => authorize(p, 'audit:read'));
  throwsCode(() => authorize(p, 'ticket:create', a.id), 'FORBIDDEN');
  throwsCode(() => authorize(p, 'ticket:create', b.id), 'TENANT_MISMATCH');
});
