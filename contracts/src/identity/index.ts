/** Multi-tenancy + RBAC. Every domain object carries a tenantId; every
 * service call carries an AccessContext. Cross-tenant access is denied by
 * construction: repositories filter by ctx.tenantId and assertTenant guards
 * single-object access. Permissions are explicit strings, roles are bundles. */
import { DomainError, forbidden } from '../core/errors.ts';
import { newTenantId, newUserId, type TenantId, type UserId } from '../core/ids.ts';

export const PERMISSIONS = [
  'contract:read', 'contract:write', 'contract:approve', 'contract:sign',
  'document:read', 'document:write', 'document:delete',
  'obligation:read', 'obligation:write',
  'audit:read', 'audit:export', 'admin:users', 'admin:retention',
  'agent:run', 'agent:approve',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = {
  admin: [...PERMISSIONS],
  counsel: ['contract:read', 'contract:write', 'contract:approve', 'document:read', 'document:write', 'obligation:read', 'obligation:write', 'audit:read', 'agent:run'],
  approver: ['contract:read', 'contract:approve', 'document:read', 'obligation:read', 'audit:read'],
  contributor: ['contract:read', 'contract:write', 'document:read', 'document:write', 'obligation:read'],
  viewer: ['contract:read', 'document:read', 'obligation:read'],
  auditor: ['contract:read', 'document:read', 'obligation:read', 'audit:read', 'audit:export'],
} as const satisfies Record<string, readonly Permission[]>;
export type Role = keyof typeof ROLES;

export interface Tenant { readonly id: TenantId; readonly name: string; readonly slug: string; readonly createdAt: string; }
export interface User {
  readonly id: UserId; readonly tenantId: TenantId; readonly email: string;
  readonly displayName: string; readonly roles: readonly Role[]; readonly active: boolean;
}

export interface AccessContext {
  readonly tenantId: TenantId; readonly userId: UserId;
  readonly permissions: ReadonlySet<Permission>;
  readonly roles: readonly Role[];
  readonly isSystem: boolean;
}

export function contextFor(user: User): AccessContext {
  const perms = new Set<Permission>();
  for (const r of user.roles) for (const p of ROLES[r]) perms.add(p);
  return { tenantId: user.tenantId, userId: user.id, permissions: perms, roles: user.roles, isSystem: false };
}
export function systemContext(tenantId: TenantId): AccessContext {
  return { tenantId, userId: 'usr_system' as UserId, permissions: new Set(PERMISSIONS), roles: Object.keys(ROLES) as Role[], isSystem: true };
}
export function requirePermission(ctx: AccessContext, perm: Permission): void {
  if (!ctx.permissions.has(perm)) throw forbidden(`missing permission: ${perm}`, { perm, userId: ctx.userId });
}
export function assertTenant(ctx: AccessContext, tenantId: TenantId): void {
  if (ctx.tenantId !== tenantId) {
    throw new DomainError('TENANT_MISMATCH', 'cross-tenant access denied', { ctxTenant: ctx.tenantId, targetTenant: tenantId });
  }
}

export class Directory {
  #tenants = new Map<TenantId, Tenant>();
  #users = new Map<UserId, User>();
  createTenant(name: string, slug: string, now: string): Tenant {
    if ([...this.#tenants.values()].some((t) => t.slug === slug)) throw new DomainError('CONFLICT', `tenant slug taken: ${slug}`);
    const t: Tenant = { id: newTenantId(), name, slug, createdAt: now };
    this.#tenants.set(t.id, t); return t;
  }
  createUser(tenantId: TenantId, email: string, displayName: string, roles: readonly Role[]): User {
    if (!this.#tenants.has(tenantId)) throw new DomainError('NOT_FOUND', `tenant not found: ${tenantId}`);
    if ([...this.#users.values()].some((u) => u.tenantId === tenantId && u.email.toLowerCase() === email.toLowerCase()))
      throw new DomainError('CONFLICT', `email already registered in tenant: ${email}`);
    const u: User = { id: newUserId(), tenantId, email, displayName, roles, active: true };
    this.#users.set(u.id, u); return u;
  }
  getUser(ctx: AccessContext, id: UserId): User {
    const u = this.#users.get(id);
    if (!u || u.tenantId !== ctx.tenantId) throw new DomainError('NOT_FOUND', `user not found: ${id}`);
    return u;
  }
  listUsers(ctx: AccessContext): User[] {
    return [...this.#users.values()].filter((u) => u.tenantId === ctx.tenantId);
  }
}
