/** Branded, prefixed identifiers. A TenantId can never be passed where a
 * ContractId is expected; prefixes make logs and exports self-describing. */
import { randomUUID } from 'node:crypto';

declare const brand: unique symbol;
export type Id<K extends string> = string & { readonly [brand]: K };

export type TenantId = Id<'tenant'>;
export type UserId = Id<'user'>;
export type ContractId = Id<'contract'>;
export type ContractVersionId = Id<'contract_version'>;
export type DocumentId = Id<'document'>;
export type ObligationId = Id<'obligation'>;
export type ApprovalId = Id<'approval'>;
export type AuditEventId = Id<'audit_event'>;
export type AgentRunId = Id<'agent_run'>;
export type TraceId = Id<'trace'>;
export type ClauseId = Id<'clause'>;
export type TemplateId = Id<'template'>;
export type PlaybookId = Id<'playbook'>;

const PREFIX = {
  tenant: 'ten', user: 'usr', contract: 'ctr', contract_version: 'ctv',
  document: 'doc', obligation: 'obl', approval: 'apr', audit_event: 'aud',
  agent_run: 'run', trace: 'trc', clause: 'cls', template: 'tpl', playbook: 'pbk',
} as const;
export type IdKind = keyof typeof PREFIX;

function make<K extends IdKind>(kind: K): Id<K> {
  return `${PREFIX[kind]}_${randomUUID()}` as Id<K>;
}
export const newTenantId = () => make('tenant');
export const newUserId = () => make('user');
export const newContractId = () => make('contract');
export const newContractVersionId = () => make('contract_version');
export const newDocumentId = () => make('document');
export const newObligationId = () => make('obligation');
export const newApprovalId = () => make('approval');
export const newAuditEventId = () => make('audit_event');
export const newAgentRunId = () => make('agent_run');
export const newTraceId = () => make('trace');
export const newClauseId = () => make('clause');
export const newTemplateId = () => make('template');
export const newPlaybookId = () => make('playbook');

export function kindOf(id: string): IdKind | null {
  const p = id.split('_')[0];
  const entry = (Object.entries(PREFIX) as [IdKind, string][]).find(([, v]) => v === p);
  return entry ? entry[0] : null;
}
export function assertKind<K extends IdKind>(id: string, kind: K): asserts id is Id<K> {
  if (kindOf(id) !== kind) throw new Error(`expected ${kind} id, got: ${id}`);
}
