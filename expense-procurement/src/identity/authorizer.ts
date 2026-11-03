import { DomainError, forbidden } from '../core/errors.js';
import type { CommandContext } from '../core/context.js';
import type { UserId } from '../core/types.js';
import { Directory, type UserRecord } from './directory.js';
import {
  AGENT_FORBIDDEN_PERMISSIONS,
  rolePermissions,
  type Permission,
  type RoleName,
} from './permissions.js';

export interface ResourceScope {
  /** The tenant that owns the resource. Defaults to the context tenant. */
  readonly tenantId?: string;
  /** The human the resource belongs to, for own-scope permissions. */
  readonly ownerId?: UserId;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly permission: Permission;
  readonly reason: string;
  readonly roles?: readonly RoleName[];
}

/**
 * Central authorization point.
 *
 * Every check is tenant-first: a context can never see or act on another
 * tenant's records, even if an identifier leaks. Agent contexts are capped by
 * an explicit deny list and act only through their delegated permissions.
 */
export class Authorizer {
  constructor(private readonly directory: Directory) {}

  permissionsFor(user: UserRecord): ReadonlySet<Permission> {
    return rolePermissions(user.roles);
  }

  decision(ctx: CommandContext, permission: Permission, scope: ResourceScope = {}): AuthorizationDecision {
    const resourceTenant = scope.tenantId ?? ctx.tenantId;
    if (resourceTenant !== ctx.tenantId) {
      return { allowed: false, permission, reason: 'resource belongs to a different tenant' };
    }
    if (ctx.actor.kind === 'agent') {
      if (AGENT_FORBIDDEN_PERMISSIONS.includes(permission)) {
        return { allowed: false, permission, reason: 'agents may never hold this capability' };
      }
      if (!ctx.actor.onBehalfOf) {
        return { allowed: false, permission, reason: 'agent has no delegated human principal' };
      }
      const principal = this.directory.findUser(ctx.tenantId, ctx.actor.onBehalfOf);
      if (!principal) {
        return { allowed: false, permission, reason: 'delegating principal not found' };
      }
      if (!principal.active) {
        return { allowed: false, permission, reason: 'delegating principal is inactive', roles: principal.roles };
      }
      const granted = rolePermissions(principal.roles);
      if (!granted.has(permission)) {
        return { allowed: false, permission, reason: 'delegating principal lacks the permission' };
      }
      return { allowed: true, permission, reason: 'delegated from human principal' };
    }
    if (ctx.actor.kind !== 'user') {
      return { allowed: false, permission, reason: 'system actor has no permissions' };
    }
    const user = this.directory.findUser(ctx.tenantId, ctx.actor.id as UserId);
    if (!user) return { allowed: false, permission, reason: 'user not found' };
    if (!user.active) return { allowed: false, permission, reason: 'user is inactive', roles: user.roles };
    const granted = rolePermissions(user.roles);
    if (!granted.has(permission)) {
      return { allowed: false, permission, reason: 'role does not grant permission', roles: user.roles };
    }
    if (permission === 'expense.read.own' && scope.ownerId && scope.ownerId !== user.id) {
      return { allowed: false, permission, reason: 'own-scope permission applies only to the owner', roles: user.roles };
    }
    return { allowed: true, permission, reason: 'role grants permission', roles: user.roles };
  }

  authorize(ctx: CommandContext, permission: Permission, scope: ResourceScope = {}): void {
    const result = this.decision(ctx, permission, scope);
    if (!result.allowed) {
      throw new DomainError('FORBIDDEN', `Permission denied: ${permission}`, {
        permission,
        reason: result.reason,
        actor: ctx.actor.id,
      });
    }
  }

  can(ctx: CommandContext, permission: Permission, scope: ResourceScope = {}): boolean {
    return this.decision(ctx, permission, scope).allowed;
  }

  /**
   * Approval authority, independent of the generic permission check.
   *
   * Segregation of duties is enforced here: nobody approves their own spend,
   * the submitter is never an approver, and the approver must either sit in the
   * submitter's management chain or hold an explicit finance approval role.
   */
  canApproveExpense(ctx: CommandContext, input: { submitterId: UserId; approvalRole?: RoleName }): boolean {
    if (ctx.actor.kind !== 'user') return false;
    const approver = this.directory.findUser(ctx.tenantId, ctx.actor.id as UserId);
    if (!approver || !approver.active) return false;
    if (approver.id === input.submitterId) return false;
    const granted = rolePermissions(approver.roles);
    if (!granted.has('expense.approve')) return false;
    if (input.approvalRole === 'manager') {
      return this.directory.chainOf(input.submitterId).includes(approver.id);
    }
    return true;
  }

  assertNotSelfApproval(ctx: CommandContext, submitterId: UserId): void {
    if (ctx.actor.kind === 'user' && ctx.actor.id === submitterId) {
      forbidden('A submitter cannot approve their own request', { submitter: submitterId });
    }
  }
}
