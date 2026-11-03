import { DomainError } from './errors.js';
import type { IdGenerator, TenantId, TeamId, UserId } from './ids.js';
import { deepFreeze, unique } from './util.js';

export type Role = 'requester' | 'agent' | 'team_lead' | 'admin' | 'auditor' | 'integration' | 'system';

export type Permission =
  | 'ticket:read'
  | 'ticket:create'
  | 'ticket:update'
  | 'ticket:assign'
  | 'ticket:transition'
  | 'ticket:close'
  | 'ticket:reopen'
  | 'ticket:note'
  | 'ticket:message'
  | 'knowledge:read'
  | 'knowledge:write'
  | 'knowledge:publish'
  | 'audit:read'
  | 'harness:run'
  | 'harness:approve'
  | 'analytics:read'
  | 'quality:write'
  | 'settings:write'
  | 'customer:read'
  | 'customer:write'
  | 'notification:manage'
  | 'integration:manage';

export const ALL_PERMISSIONS: readonly Permission[] = [
  'ticket:read',
  'ticket:create',
  'ticket:update',
  'ticket:assign',
  'ticket:transition',
  'ticket:close',
  'ticket:reopen',
  'ticket:note',
  'ticket:message',
  'knowledge:read',
  'knowledge:write',
  'knowledge:publish',
  'audit:read',
  'harness:run',
  'harness:approve',
  'analytics:read',
  'quality:write',
  'settings:write',
  'customer:read',
  'customer:write',
  'notification:manage',
  'integration:manage',
];

const AGENT_PERMISSIONS: readonly Permission[] = [
  'ticket:read',
  'ticket:create',
  'ticket:update',
  'ticket:assign',
  'ticket:transition',
  'ticket:close',
  'ticket:reopen',
  'ticket:note',
  'ticket:message',
  'knowledge:read',
  'knowledge:write',
  'analytics:read',
  'customer:read',
  'harness:run',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = deepFreeze({
  requester: ['ticket:read', 'ticket:create', 'ticket:message', 'knowledge:read'],
  agent: AGENT_PERMISSIONS,
  team_lead: unique([
    ...AGENT_PERMISSIONS,
    'harness:approve',
    'quality:write',
    'knowledge:publish',
    'customer:write',
    'notification:manage',
  ]) as readonly Permission[],
  admin: ALL_PERMISSIONS,
  auditor: ['ticket:read', 'knowledge:read', 'audit:read', 'analytics:read'],
  integration: [
    'ticket:read',
    'ticket:create',
    'ticket:update',
    'ticket:message',
    'knowledge:read',
    'customer:read',
    'integration:manage',
  ],
  system: ALL_PERMISSIONS,
});

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly plan: 'trial' | 'standard' | 'enterprise';
  readonly status: 'active' | 'suspended';
  readonly retentionDays: number;
  readonly createdAt: string;
}

export interface User {
  readonly id: UserId;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  readonly teamIds: readonly TeamId[];
  readonly status: 'active' | 'suspended';
}

export interface Principal {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
}

export interface CreateTenantInput {
  readonly name: string;
  readonly plan?: Tenant['plan'];
  readonly retentionDays?: number;
}

export interface CreateUserInput {
  readonly tenantId: TenantId;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  readonly teamIds?: readonly TeamId[];
}

export class IdentityService {
  private readonly tenants = new Map<string, Tenant>();
  private readonly users = new Map<string, User>();

  constructor(private readonly ids: IdGenerator) {}

  createTenant(input: CreateTenantInput): Tenant {
    const name = input.name.trim();
    if (name.length < 2) throw new DomainError('VALIDATION', 'Tenant name is too short');
    const id = this.ids.next('ten') as TenantId;
    const tenant: Tenant = deepFreeze({
      id,
      name,
      plan: input.plan ?? 'standard',
      status: 'active',
      retentionDays: input.retentionDays ?? 365,
      createdAt: new Date(0).toISOString(),
    });
    this.tenants.set(id, tenant);
    return tenant;
  }

  getTenant(tenantId: TenantId): Tenant {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new DomainError('NOT_FOUND', 'Tenant not found', { tenantId });
    return tenant;
  }

  createUser(input: CreateUserInput): User {
    const tenant = this.getTenant(input.tenantId);
    if (tenant.status !== 'active') {
      throw new DomainError('FORBIDDEN', 'Tenant is not active', { tenantId: tenant.id });
    }
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new DomainError('VALIDATION', 'Invalid email address', { email: input.email });
    }
    for (const user of this.users.values()) {
      if (user.tenantId === input.tenantId && user.email === email) {
        throw new DomainError('CONFLICT', 'User already exists in tenant', { email });
      }
    }
    if (input.roles.length === 0) {
      throw new DomainError('VALIDATION', 'User requires at least one role');
    }
    const id = this.ids.next('usr') as UserId;
    const user: User = deepFreeze({
      id,
      tenantId: input.tenantId,
      email,
      displayName: input.displayName.trim() || email,
      roles: unique(input.roles),
      teamIds: unique(input.teamIds ?? []),
      status: 'active',
    });
    this.users.set(id, user);
    return user;
  }

  getUser(userId: UserId): User {
    const user = this.users.get(userId);
    if (!user) throw new DomainError('NOT_FOUND', 'User not found', { userId });
    return user;
  }

  listUsers(tenantId: TenantId): readonly User[] {
    return [...this.users.values()].filter((user) => user.tenantId === tenantId);
  }

  principalFor(userId: UserId): Principal {
    const user = this.getUser(userId);
    if (user.status !== 'active') {
      throw new DomainError('FORBIDDEN', 'User is suspended', { userId });
    }
    return principalFromUser(user);
  }

  systemPrincipal(tenantId: TenantId): Principal {
    return deepFreeze({
      userId: 'usr_system' as UserId,
      tenantId,
      roles: ['system'] as readonly Role[],
      permissions: new Set(ROLE_PERMISSIONS.system),
    });
  }
}

export function principalFromUser(user: User): Principal {
  const permissions = new Set<Permission>();
  for (const role of user.roles) {
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  }
  return deepFreeze({
    userId: user.id,
    tenantId: user.tenantId,
    roles: user.roles,
    permissions,
  });
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

export function assertTenant(principal: Principal, tenantId: TenantId): void {
  if (principal.tenantId !== tenantId) {
    throw new DomainError('TENANT_MISMATCH', 'Cross-tenant access denied', {
      principalTenant: principal.tenantId,
      resourceTenant: tenantId,
    });
  }
}

export function authorize(
  principal: Principal,
  permission: Permission,
  resourceTenantId?: TenantId,
): void {
  if (resourceTenantId) assertTenant(principal, resourceTenantId);
  if (!hasPermission(principal, permission)) {
    throw new DomainError('FORBIDDEN', 'Permission denied', {
      permission,
      userId: principal.userId,
    });
  }
}

export function roleOf(principal: Principal, role: Role): boolean {
  return principal.roles.includes(role);
}
