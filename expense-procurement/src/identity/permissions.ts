/**
 * Permission catalogue. Permissions are verbs over resources, expressed as
 * stable strings so that policy documents, roles and the agent harness can all
 * talk about the same capability set.
 */
export type Permission =
  | 'expense.read.own'
  | 'expense.read.all'
  | 'expense.submit'
  | 'expense.approve'
  | 'expense.override'
  | 'receipt.capture'
  | 'requisition.read'
  | 'requisition.create'
  | 'requisition.approve'
  | 'purchase_order.read'
  | 'purchase_order.manage'
  | 'purchase_order.approve'
  | 'goods_receipt.record'
  | 'invoice.read'
  | 'invoice.manage'
  | 'invoice.approve'
  | 'vendor.read'
  | 'vendor.manage'
  | 'payment.read'
  | 'payment.execute'
  | 'ledger.read'
  | 'ledger.post'
  | 'policy.read'
  | 'policy.manage'
  | 'audit.read'
  | 'analytics.read'
  | 'agent.run'
  | 'agent.configure'
  | 'tenant.admin';

export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze([
  'expense.read.own',
  'expense.read.all',
  'expense.submit',
  'expense.approve',
  'expense.override',
  'receipt.capture',
  'requisition.read',
  'requisition.create',
  'requisition.approve',
  'purchase_order.read',
  'purchase_order.manage',
  'purchase_order.approve',
  'goods_receipt.record',
  'invoice.read',
  'invoice.manage',
  'invoice.approve',
  'vendor.read',
  'vendor.manage',
  'payment.read',
  'payment.execute',
  'ledger.read',
  'ledger.post',
  'policy.read',
  'policy.manage',
  'audit.read',
  'analytics.read',
  'agent.run',
  'agent.configure',
  'tenant.admin',
]);

export type RoleName =
  | 'employee'
  | 'manager'
  | 'finance_analyst'
  | 'controller'
  | 'procurement_officer'
  | 'ap_clerk'
  | 'auditor'
  | 'tenant_admin';

const READ_ONLY: readonly Permission[] = ['expense.read.own', 'policy.read', 'receipt.capture', 'expense.submit'];

function frozenPermissions(...permissions: Permission[]): readonly Permission[] {
  return Object.freeze(permissions);
}

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = Object.freeze({
  employee: frozenPermissions(...READ_ONLY),
  manager: frozenPermissions(
    ...READ_ONLY,
    'expense.read.all',
    'expense.approve',
    'requisition.read',
    'requisition.create',
    'requisition.approve',
    'purchase_order.read',
    'invoice.read',
    'analytics.read',
  ),
  finance_analyst: frozenPermissions(
    'expense.read.all',
    'expense.override',
    'receipt.capture',
    'requisition.read',
    'purchase_order.read',
    'invoice.read',
    'invoice.manage',
    'vendor.read',
    'payment.read',
    'ledger.read',
    'ledger.post',
    'policy.read',
    'analytics.read',
  ),
  controller: frozenPermissions(
    'expense.read.all',
    'expense.approve',
    'expense.override',
    'requisition.read',
    'requisition.approve',
    'purchase_order.read',
    'purchase_order.approve',
    'invoice.read',
    'invoice.approve',
    'invoice.manage',
    'vendor.read',
    'vendor.manage',
    'payment.read',
    'payment.execute',
    'ledger.read',
    'ledger.post',
    'policy.read',
    'policy.manage',
    'audit.read',
    'analytics.read',
    'agent.run',
    'agent.configure',
  ),
  procurement_officer: frozenPermissions(
    'requisition.read',
    'requisition.create',
    'requisition.approve',
    'purchase_order.read',
    'purchase_order.manage',
    'purchase_order.approve',
    'goods_receipt.record',
    'vendor.read',
    'vendor.manage',
    'invoice.read',
    'policy.read',
    'analytics.read',
  ),
  ap_clerk: frozenPermissions(
    'invoice.read',
    'invoice.manage',
    'purchase_order.read',
    'goods_receipt.record',
    'vendor.read',
    'payment.read',
    'ledger.read',
    'policy.read',
  ),
  auditor: frozenPermissions(
    'expense.read.all',
    'requisition.read',
    'purchase_order.read',
    'invoice.read',
    'vendor.read',
    'payment.read',
    'ledger.read',
    'audit.read',
    'policy.read',
    'analytics.read',
  ),
  tenant_admin: ALL_PERMISSIONS,
});

/**
 * Capabilities an autonomous agent may never hold. AI assists with extraction,
 * categorisation, drafting and risk signals; it cannot approve, override
 * policy, move money or rewrite the rulebook.
 */
export const AGENT_FORBIDDEN_PERMISSIONS: readonly Permission[] = Object.freeze([
  'expense.approve',
  'expense.override',
  'requisition.approve',
  'purchase_order.approve',
  'invoice.approve',
  'payment.execute',
  'policy.manage',
  'tenant.admin',
  'agent.configure',
]);

export function rolePermissions(roles: readonly RoleName[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}
