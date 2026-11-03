import { defineWorkflow, type WorkflowDefinition } from './machine.js';

export type ExpenseReportState =
  | 'draft'
  | 'submitted'
  | 'in_approval'
  | 'changes_requested'
  | 'exception_review'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'cancelled';

export type RequisitionState =
  | 'draft'
  | 'submitted'
  | 'in_approval'
  | 'approved'
  | 'rejected'
  | 'converted'
  | 'cancelled';

export type PurchaseOrderState =
  | 'draft'
  | 'issued'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'cancelled';

export type InvoiceState =
  | 'received'
  | 'exception'
  | 'matched'
  | 'approved'
  | 'scheduled'
  | 'paid'
  | 'rejected';

export type VendorState = 'prospect' | 'in_review' | 'active' | 'suspended' | 'archived';

const hasApprovals = (ctx: { facts: Readonly<Record<string, unknown>> }): boolean =>
  ctx.facts.approvalsComplete === true;

export const expenseReportWorkflow: WorkflowDefinition<ExpenseReportState> = defineWorkflow({
  name: 'expense_report',
  initial: 'draft',
  states: [
    { state: 'draft', label: 'Draft', terminal: false },
    { state: 'submitted', label: 'Submitted', terminal: false },
    { state: 'in_approval', label: 'In approval', terminal: false },
    { state: 'changes_requested', label: 'Changes requested', terminal: false },
    { state: 'exception_review', label: 'Exception review', terminal: false },
    { state: 'approved', label: 'Approved', terminal: false },
    { state: 'rejected', label: 'Rejected', terminal: true },
    { state: 'paid', label: 'Paid', terminal: true },
    { state: 'cancelled', label: 'Cancelled', terminal: true },
  ],
  transitions: [
    { action: 'submit', from: 'draft', to: 'submitted', label: 'Submit report', permission: 'expense.submit', event: 'expense_report.submitted' },
    { action: 'begin_review', from: 'submitted', to: 'in_approval', label: 'Route for approval', event: 'expense_report.routed' },
    { action: 'begin_review', from: 'submitted', to: 'exception_review', label: 'Hold for exception review', guard: (ctx) => (ctx.facts.policyBlocked === true ? true : { ok: false, reason: 'no blocking policy violation' }), event: 'expense_report.exception_hold' },
    {
      action: 'approve',
      from: 'in_approval',
      to: 'approved',
      label: 'Approve report',
      permission: 'expense.approve',
      guard: (ctx) => (hasApprovals(ctx) ? true : { ok: false, reason: 'approval steps are not complete' }),
      event: 'expense_report.approved',
    },
    { action: 'reject', from: 'in_approval', to: 'rejected', label: 'Reject report', permission: 'expense.approve', event: 'expense_report.rejected' },
    { action: 'request_changes', from: 'in_approval', to: 'changes_requested', label: 'Request changes', permission: 'expense.approve', event: 'expense_report.changes_requested' },
    { action: 'flag_exception', from: 'in_approval', to: 'exception_review', label: 'Flag policy exception', permission: 'expense.approve', event: 'expense_report.exception_flagged' },
    { action: 'resubmit', from: 'changes_requested', to: 'submitted', label: 'Resubmit report', permission: 'expense.submit', event: 'expense_report.resubmitted' },
    { action: 'override', from: 'exception_review', to: 'in_approval', label: 'Override policy block', permission: 'expense.override', guard: (ctx) => (String(ctx.facts.overrideReason ?? '').trim().length >= 10 ? true : { ok: false, reason: 'an override reason of at least 10 characters is required' }), event: 'expense_report.override_granted' },
    { action: 'reject', from: 'exception_review', to: 'rejected', label: 'Reject report', permission: 'expense.approve', event: 'expense_report.rejected' },
    { action: 'cancel', from: 'draft', to: 'cancelled', label: 'Cancel draft', permission: 'expense.submit', event: 'expense_report.cancelled' },
    { action: 'cancel', from: 'changes_requested', to: 'cancelled', label: 'Cancel report', permission: 'expense.submit', event: 'expense_report.cancelled' },
    { action: 'pay', from: 'approved', to: 'paid', label: 'Mark reimbursed', permission: 'payment.execute', event: 'expense_report.paid' },
  ],
});

export const requisitionWorkflow: WorkflowDefinition<RequisitionState> = defineWorkflow({
  name: 'requisition',
  initial: 'draft',
  states: [
    { state: 'draft', label: 'Draft', terminal: false },
    { state: 'submitted', label: 'Submitted', terminal: false },
    { state: 'in_approval', label: 'In approval', terminal: false },
    { state: 'approved', label: 'Approved', terminal: false },
    { state: 'rejected', label: 'Rejected', terminal: true },
    { state: 'converted', label: 'Converted to purchase order', terminal: true },
    { state: 'cancelled', label: 'Cancelled', terminal: true },
  ],
  transitions: [
    { action: 'submit', from: 'draft', to: 'submitted', label: 'Submit requisition', permission: 'requisition.create', event: 'requisition.submitted' },
    { action: 'begin_review', from: 'submitted', to: 'in_approval', label: 'Route for approval', event: 'requisition.routed' },
    { action: 'approve', from: 'in_approval', to: 'approved', label: 'Approve requisition', permission: 'requisition.approve', guard: hasApprovals, event: 'requisition.approved' },
    { action: 'reject', from: 'in_approval', to: 'rejected', label: 'Reject requisition', permission: 'requisition.approve', event: 'requisition.rejected' },
    { action: 'cancel', from: 'draft', to: 'cancelled', label: 'Cancel requisition', permission: 'requisition.create', event: 'requisition.cancelled' },
    { action: 'cancel', from: 'submitted', to: 'cancelled', label: 'Cancel requisition', permission: 'requisition.create', event: 'requisition.cancelled' },
    { action: 'convert', from: 'approved', to: 'converted', label: 'Create purchase order', permission: 'purchase_order.manage', event: 'requisition.converted' },
  ],
});

export const purchaseOrderWorkflow: WorkflowDefinition<PurchaseOrderState> = defineWorkflow({
  name: 'purchase_order',
  initial: 'draft',
  states: [
    { state: 'draft', label: 'Draft', terminal: false },
    { state: 'issued', label: 'Issued', terminal: false },
    { state: 'partially_received', label: 'Partially received', terminal: false },
    { state: 'received', label: 'Received', terminal: false },
    { state: 'closed', label: 'Closed', terminal: true },
    { state: 'cancelled', label: 'Cancelled', terminal: true },
  ],
  transitions: [
    { action: 'issue', from: 'draft', to: 'issued', label: 'Issue purchase order', permission: 'purchase_order.manage', event: 'purchase_order.issued' },
    { action: 'receive', from: 'issued', to: 'partially_received', label: 'Record partial receipt', permission: 'goods_receipt.record', guard: (ctx) => (ctx.facts.fullyReceived === true ? false : true), event: 'purchase_order.partially_received' },
    { action: 'receive', from: 'issued', to: 'received', label: 'Record full receipt', permission: 'goods_receipt.record', guard: (ctx) => (ctx.facts.fullyReceived === true ? true : { ok: false, reason: 'not all order lines are received' }), event: 'purchase_order.received' },
    { action: 'receive', from: 'partially_received', to: 'received', label: 'Complete receipt', permission: 'goods_receipt.record', guard: (ctx) => (ctx.facts.fullyReceived === true ? true : { ok: false, reason: 'not all order lines are received' }), event: 'purchase_order.received' },
    { action: 'close', from: 'received', to: 'closed', label: 'Close purchase order', permission: 'purchase_order.manage', event: 'purchase_order.closed' },
    { action: 'cancel', from: 'draft', to: 'cancelled', label: 'Cancel purchase order', permission: 'purchase_order.manage', event: 'purchase_order.cancelled' },
    { action: 'cancel', from: 'issued', to: 'cancelled', label: 'Cancel purchase order', permission: 'purchase_order.manage', event: 'purchase_order.cancelled' },
  ],
});

export const invoiceWorkflow: WorkflowDefinition<InvoiceState> = defineWorkflow({
  name: 'invoice',
  initial: 'received',
  states: [
    { state: 'received', label: 'Received', terminal: false },
    { state: 'exception', label: 'Exception', terminal: false },
    { state: 'matched', label: 'Matched', terminal: false },
    { state: 'approved', label: 'Approved', terminal: false },
    { state: 'scheduled', label: 'Scheduled for payment', terminal: false },
    { state: 'paid', label: 'Paid', terminal: true },
    { state: 'rejected', label: 'Rejected', terminal: true },
  ],
  transitions: [
    { action: 'match', from: 'received', to: 'matched', label: 'Match invoice', event: 'invoice.matched' },
    { action: 'flag_exception', from: 'received', to: 'exception', label: 'Flag exception', event: 'invoice.exception' },
    { action: 'flag_exception', from: 'matched', to: 'exception', label: 'Flag exception', event: 'invoice.exception' },
    { action: 'resolve_exception', from: 'exception', to: 'matched', label: 'Resolve exception', permission: 'invoice.manage', event: 'invoice.exception_resolved' },
    { action: 'approve', from: 'matched', to: 'approved', label: 'Approve invoice', permission: 'invoice.approve', event: 'invoice.approved' },
    { action: 'reject', from: 'exception', to: 'rejected', label: 'Reject invoice', permission: 'invoice.approve', event: 'invoice.rejected' },
    { action: 'reject', from: 'matched', to: 'rejected', label: 'Reject invoice', permission: 'invoice.approve', event: 'invoice.rejected' },
    { action: 'schedule', from: 'approved', to: 'scheduled', label: 'Schedule payment', permission: 'payment.execute', event: 'invoice.scheduled' },
    { action: 'pay', from: 'scheduled', to: 'paid', label: 'Pay invoice', permission: 'payment.execute', event: 'invoice.paid' },
  ],
});

export const vendorWorkflow: WorkflowDefinition<VendorState> = defineWorkflow({
  name: 'vendor',
  initial: 'prospect',
  states: [
    { state: 'prospect', label: 'Prospect', terminal: false },
    { state: 'in_review', label: 'In review', terminal: false },
    { state: 'active', label: 'Active', terminal: false },
    { state: 'suspended', label: 'Suspended', terminal: false },
    { state: 'archived', label: 'Archived', terminal: true },
  ],
  transitions: [
    { action: 'submit', from: 'prospect', to: 'in_review', label: 'Submit vendor for review', permission: 'vendor.manage', event: 'vendor.submitted' },
    { action: 'activate', from: 'in_review', to: 'active', label: 'Activate vendor', permission: 'vendor.manage', guard: (ctx) => (ctx.facts.complianceComplete === true ? true : { ok: false, reason: 'vendor compliance checks are incomplete' }), event: 'vendor.activated' },
    { action: 'suspend', from: 'active', to: 'suspended', label: 'Suspend vendor', permission: 'vendor.manage', event: 'vendor.suspended' },
    { action: 'reinstate', from: 'suspended', to: 'active', label: 'Reinstate vendor', permission: 'vendor.manage', event: 'vendor.reinstated' },
    { action: 'archive', from: 'suspended', to: 'archived', label: 'Archive vendor', permission: 'vendor.manage', event: 'vendor.archived' },
  ],
});

export const WORKFLOWS = Object.freeze({
  expense_report: expenseReportWorkflow,
  requisition: requisitionWorkflow,
  purchase_order: purchaseOrderWorkflow,
  invoice: invoiceWorkflow,
  vendor: vendorWorkflow,
});
