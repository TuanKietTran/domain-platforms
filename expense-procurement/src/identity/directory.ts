import { DomainError, notFound } from '../core/errors.js';
import { tenantId, type TenantId, type UserId } from '../core/types.js';
import type { RoleName } from './permissions.js';

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly slug: string;
  readonly baseCurrency: 'USD' | 'EUR' | 'GBP';
  readonly createdAt: string;
  readonly status: 'active' | 'suspended';
}

export interface UserRecord {
  readonly id: UserId;
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly email: string;
  readonly roles: readonly RoleName[];
  readonly managerId?: UserId;
  readonly costCenterIds: readonly string[];
  readonly active: boolean;
}

export interface NewUser {
  readonly id: UserId;
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly email: string;
  readonly roles: readonly RoleName[];
  readonly managerId?: UserId;
  readonly costCenterIds?: readonly string[];
}

export interface CostCenter {
  readonly tenantId: TenantId;
  readonly code: string;
  readonly name: string;
  readonly ownerId?: UserId;
}

/**
 * Tenant-scoped identity directory. There is no cross-tenant lookup path: every
 * read takes a tenant and every write is checked against the tenant of the
 * record being written.
 */
export class Directory {
  private readonly tenants = new Map<string, Tenant>();
  private readonly users = new Map<string, UserRecord>();
  private readonly costCenters = new Map<string, CostCenter>();

  createTenant(input: { name: string; slug: string; baseCurrency?: 'USD' | 'EUR' | 'GBP' }): Tenant {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) {
      throw new DomainError('VALIDATION', 'Tenant slug must be lowercase alphanumeric or dash', { slug });
    }
    if ([...this.tenants.values()].some((tenant) => tenant.slug === slug)) {
      throw new DomainError('CONFLICT', 'Tenant slug already exists', { slug });
    }
    const tenant: Tenant = Object.freeze({
      id: tenantId(`tn_${slug.replace(/-/g, '_')}`),
      name: input.name.trim(),
      slug,
      baseCurrency: input.baseCurrency ?? 'USD',
      createdAt: new Date(0).toISOString(),
      status: 'active',
    });
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  requireTenant(id: TenantId): Tenant {
    const tenant = this.tenants.get(id);
    if (!tenant) notFound('Tenant', id);
    return tenant;
  }

  addUser(input: NewUser): UserRecord {
    this.requireTenant(input.tenantId);
    if (this.users.has(input.id)) throw new DomainError('CONFLICT', 'User already exists', { id: input.id });
    if (!input.email.includes('@')) throw new DomainError('VALIDATION', 'Email is required', { email: input.email });
    if (input.managerId) {
      const manager = this.requireUser(input.tenantId, input.managerId);
      if (manager.id === input.id) throw new DomainError('VALIDATION', 'A user cannot manage themselves');
    }
    const record: UserRecord = Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      displayName: input.displayName.trim(),
      email: input.email.trim().toLowerCase(),
      roles: Object.freeze([...input.roles]),
      ...(input.managerId ? { managerId: input.managerId } : {}),
      costCenterIds: Object.freeze([...new Set(input.costCenterIds ?? [])]),
      active: true,
    });
    this.users.set(record.id, record);
    return record;
  }

  requireUser(tenantIdValue: TenantId, userId: UserId): UserRecord {
    const user = this.users.get(userId);
    if (!user || user.tenantId !== tenantIdValue) notFound('User', userId);
    return user;
  }

  /** Non-throwing lookup for authorization checks: unknown or cross-tenant ids return undefined. */
  findUser(tenantIdValue: TenantId, userId: UserId): UserRecord | undefined {
    const user = this.users.get(userId);
    return user && user.tenantId === tenantIdValue ? user : undefined;
  }

  findUserByEmail(tenantIdValue: TenantId, email: string): UserRecord | undefined {
    const target = email.trim().toLowerCase();
    return [...this.users.values()].find((user) => user.tenantId === tenantIdValue && user.email === target);
  }

  usersOf(tenantIdValue: TenantId): readonly UserRecord[] {
    return [...this.users.values()].filter((user) => user.tenantId === tenantIdValue);
  }

  setRoles(tenantIdValue: TenantId, userId: UserId, roles: readonly RoleName[]): UserRecord {
    const user = this.requireUser(tenantIdValue, userId);
    const updated: UserRecord = Object.freeze({ ...user, roles: Object.freeze([...new Set(roles)]) });
    this.users.set(userId, updated);
    return updated;
  }

  setManager(tenantIdValue: TenantId, userId: UserId, managerId: UserId | undefined): UserRecord {
    const user = this.requireUser(tenantIdValue, userId);
    if (managerId) {
      const manager = this.requireUser(tenantIdValue, managerId);
      if (manager.id === userId) throw new DomainError('VALIDATION', 'A user cannot manage themselves');
      if (this.chainOf(manager.id).includes(userId)) {
        throw new DomainError('VALIDATION', 'Manager assignment would create a cycle');
      }
    }
    const updated: UserRecord = Object.freeze({ ...user, ...(managerId ? { managerId } : {}) });
    this.users.set(userId, updated);
    return updated;
  }

  deactivateUser(tenantIdValue: TenantId, userId: UserId): UserRecord {
    const user = this.requireUser(tenantIdValue, userId);
    const updated: UserRecord = Object.freeze({ ...user, active: false });
    this.users.set(userId, updated);
    return updated;
  }

  /** Manager chain from the user upwards, nearest first. */
  chainOf(userId: UserId): readonly UserId[] {
    const chain: UserId[] = [];
    let current = this.users.get(userId)?.managerId;
    while (current && !chain.includes(current) && chain.length < 32) {
      chain.push(current);
      current = this.users.get(current)?.managerId;
    }
    return chain;
  }

  addCostCenter(input: { tenantId: TenantId; code: string; name: string; ownerId?: UserId }): CostCenter {
    this.requireTenant(input.tenantId);
    if (!/^[A-Z0-9][A-Z0-9-]{1,15}$/.test(input.code)) {
      throw new DomainError('VALIDATION', 'Cost center code must be uppercase alphanumeric or dash', { code: input.code });
    }
    const key = `${input.tenantId}:${input.code}`;
    if (this.costCenters.has(key)) throw new DomainError('CONFLICT', 'Cost center already exists', { code: input.code });
    const record: CostCenter = Object.freeze({ ...input });
    this.costCenters.set(key, record);
    return record;
  }

  requireCostCenter(tenantIdValue: TenantId, code: string): CostCenter {
    const record = this.costCenters.get(`${tenantIdValue}:${code}`);
    if (!record) notFound('Cost center', code);
    return record;
  }

  costCentersOf(tenantIdValue: TenantId): readonly CostCenter[] {
    return [...this.costCenters.values()].filter((center) => center.tenantId === tenantIdValue);
  }
}
