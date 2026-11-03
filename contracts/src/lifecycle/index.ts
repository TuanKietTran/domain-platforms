/** Contract lifecycle state machine. Transitions are explicit, guarded and
 * audited. Terminal states: terminated, expired, rejected. Content edits are
 * only allowed pre-signature; post-signature change happens via amendments
 * (new contracts linked to the original), never by rewriting history. */
import { DomainError } from '../core/errors.ts';
import { newContractId, type ContractId, type TenantId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext } from '../identity/index.ts';
import { assertTenant, requirePermission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';
import { VersionStore, type ContractContent } from '../versioning/index.ts';
import { assessRisk, assessWithDeviations, requiredApprovers, type ApprovalService } from '../risk/index.ts';
import type { PlaybookService } from '../clauses/playbook.ts';

export const CONTRACT_STATES = [
  'draft', 'in_review', 'approved', 'sent_for_signature', 'signed',
  'active', 'suspended', 'expired', 'terminated', 'rejected',
] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

export const TRANSITIONS: Readonly<Record<ContractState, readonly ContractState[]>> = {
  draft: ['in_review', 'rejected'],
  in_review: ['approved', 'draft', 'rejected'],
  approved: ['sent_for_signature', 'draft'],
  sent_for_signature: ['signed', 'draft'],
  signed: ['active', 'terminated'],
  active: ['suspended', 'expired', 'terminated'],
  suspended: ['active', 'terminated'],
  expired: [], terminated: [], rejected: [],
};
export const TERMINAL_STATES: readonly ContractState[] = ['expired', 'terminated', 'rejected'];
export function canTransition(from: ContractState, to: ContractState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type ContractKind = 'msa' | 'sow' | 'nda' | 'dpa' | 'order_form' | 'amendment' | 'other';
export interface Contract {
  readonly id: ContractId; readonly tenantId: TenantId;
  readonly kind: ContractKind; readonly counterparty: string;
  readonly state: ContractState; readonly ownerId: UserId;
  readonly currentVersionId: string; readonly amendmentOf: ContractId | null;
  readonly effectiveAt: string | null; readonly expiresAt: string | null;
  readonly createdAt: string; readonly updatedAt: string;
}

export interface ContractServiceDeps {
  clock: Clock; audit: AuditLog; versions: VersionStore;
  /** When set, the -> approved transition is gated: a completed approval
   * request covering requiredApprovers(assessRisk(current content)) must
   * exist first. When unset, transitions keep permission-only behaviour. */
  approvals?: ApprovalService;
  /** Optional playbook scoring for the gate: deviations from this playbook
   * are folded into the risk assessment before the matrix is computed. */
  playbooks?: PlaybookService;
  playbookKey?: string;
}

export class ContractService {
  #contracts = new Map<ContractId, Contract>();
  readonly #deps: ContractServiceDeps;
  constructor(deps: ContractServiceDeps) { this.#deps = deps; }

  create(ctx: AccessContext, input: { kind: ContractKind; counterparty: string; content: ContractContent; amendmentOf?: ContractId }): Contract {
    requirePermission(ctx, 'contract:write');
    if (!input.counterparty.trim()) throw new DomainError('VALIDATION', 'counterparty is required');
    if (input.amendmentOf) {
      const parent = this.get(ctx, input.amendmentOf);
      if (parent.state !== 'active' && parent.state !== 'signed')
        throw new DomainError('VALIDATION', 'amendments require a signed or active parent', { parentState: parent.state });
    }
    const id = newContractId();
    const v = this.#deps.versions.create(id, input.content, { source: 'human', createdBy: ctx.userId, note: 'initial version' });
    const now = this.#deps.clock.now().toISOString();
    const c: Contract = {
      id, tenantId: ctx.tenantId, kind: input.kind, counterparty: input.counterparty,
      state: 'draft', ownerId: ctx.userId, currentVersionId: v.id,
      amendmentOf: input.amendmentOf ?? null, effectiveAt: null, expiresAt: null,
      createdAt: now, updatedAt: now,
    };
    this.#contracts.set(id, c);
    this.#deps.audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'contract.created', subjectType: 'contract', subjectId: id, detail: { kind: c.kind, counterparty: c.counterparty, version: v.number } });
    return c;
  }

  get(ctx: AccessContext, id: ContractId): Contract {
    requirePermission(ctx, 'contract:read');
    const c = this.#contracts.get(id);
    if (!c) throw new DomainError('NOT_FOUND', `contract not found: ${id}`);
    assertTenant(ctx, c.tenantId);
    return c;
  }
  list(ctx: AccessContext, filter: { state?: ContractState; kind?: ContractKind } = {}): Contract[] {
    requirePermission(ctx, 'contract:read');
    return [...this.#contracts.values()].filter((c) => c.tenantId === ctx.tenantId
      && (filter.state === undefined || c.state === filter.state)
      && (filter.kind === undefined || c.kind === filter.kind));
  }

  addVersion(ctx: AccessContext, id: ContractId, content: ContractContent, note = ''): Contract {
    requirePermission(ctx, 'contract:write');
    const c = this.get(ctx, id);
    if (!['draft', 'in_review'].includes(c.state))
      throw new DomainError('IMMUTABLE', `content is locked in state ${c.state}; use an amendment`, { state: c.state });
    const v = this.#deps.versions.create(id, content, { source: 'human', createdBy: ctx.userId, note });
    const updated = { ...c, currentVersionId: v.id, updatedAt: this.#deps.clock.now().toISOString() };
    this.#contracts.set(id, updated);
    this.#deps.audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'contract.version.created', subjectType: 'contract', subjectId: id, detail: { version: v.number, hash: v.contentHash } });
    return updated;
  }

  transition(ctx: AccessContext, id: ContractId, to: ContractState, opts: { effectiveAt?: string; expiresAt?: string; valueMinor?: number; termMonths?: number } = {}): Contract {
    const c = this.get(ctx, id);
    if (!canTransition(c.state, to))
      throw new DomainError('INVALID_TRANSITION', `cannot transition ${c.state} -> ${to}`, { from: c.state, to, allowed: TRANSITIONS[c.state] });
    const perm = to === 'approved' ? 'contract:approve' : to === 'signed' ? 'contract:sign' : 'contract:write';
    requirePermission(ctx, perm);
    if (to === 'approved' && this.#deps.approvals) {
      const content = this.#deps.versions.current(id).content;
      const meta: { valueMinor?: number; termMonths?: number } = {
        ...(opts.valueMinor !== undefined ? { valueMinor: opts.valueMinor } : {}),
        ...(opts.termMonths !== undefined ? { termMonths: opts.termMonths } : {}),
      };
      const assessment = this.#deps.playbooks && this.#deps.playbookKey
        ? assessWithDeviations(content, this.#deps.playbooks.assessDeviations(ctx, this.#deps.playbookKey, content), meta)
        : assessRisk(content, meta);
      const required = requiredApprovers(assessment, opts.valueMinor ?? 0);
      if (!this.#deps.approvals.approvedFor(ctx, id, required))
        throw new DomainError('APPROVAL_REQUIRED', 'approval gate: no completed approval covers the required roles for this risk level', { requiredRoles: required, band: assessment.band, score: assessment.score });
    }
    const now = this.#deps.clock.now().toISOString();
    const updated: Contract = {
      ...c, state: to, updatedAt: now,
      effectiveAt: to === 'active' ? (opts.effectiveAt ?? now) : c.effectiveAt,
      expiresAt: opts.expiresAt ?? c.expiresAt,
    };
    this.#contracts.set(id, updated);
    this.#deps.audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'contract.transitioned', subjectType: 'contract', subjectId: id, detail: { from: c.state, to } });
    return updated;
  }
}
