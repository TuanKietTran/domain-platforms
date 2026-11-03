/** Risk scoring + approval routing. Deterministic rules over contract
 * content and metadata produce an explainable score; the approval matrix
 * maps score bands and contract value to required approver roles. No ML:
 * every point in the score names the rule that produced it. */
import { DomainError } from '../core/errors.ts';
import { newApprovalId, type ApprovalId, type ContractId, type TenantId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext, Role } from '../identity/index.ts';
import { assertTenant, requirePermission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';
import type { ContractContent } from '../versioning/index.ts';
import type { ClauseDeviation } from '../clauses/types.ts';

export interface RiskSignal { readonly rule: string; readonly points: number; readonly evidence: string; }
export interface RiskAssessment { readonly score: number; readonly band: 'low' | 'medium' | 'high' | 'critical'; readonly signals: readonly RiskSignal[]; }

const PATTERNS: { rule: string; points: number; re: RegExp; label: string }[] = [
  { rule: 'unlimited_liability', points: 30, re: /unlimited liability/i, label: 'unlimited liability language' },
  { rule: 'indemnity_broad', points: 15, re: /indemnif\w*[^.]*all (claims|losses|damages)/i, label: 'broad indemnity' },
  { rule: 'auto_renewal', points: 10, re: /auto-?renew/i, label: 'auto-renewal clause' },
  { rule: 'termination_for_convenience_counterparty', points: 15, re: /may terminate for convenience/i, label: 'counterparty termination for convenience' },
  { rule: 'ip_assignment_broad', points: 15, re: /all (intellectual property|ip) (created|developed)/i, label: 'broad IP assignment' },
  { rule: 'governing_law_foreign', points: 10, re: /governed by the laws of (?!Vietnam)/i, label: 'foreign governing law' },
];

const bandFor = (score: number): RiskAssessment['band'] => (score >= 60 ? 'critical' : score >= 35 ? 'high' : score >= 15 ? 'medium' : 'low');

export function assessRisk(content: ContractContent, meta: { valueMinor?: number; termMonths?: number } = {}): RiskAssessment {
  const text = [content.title, ...content.clauses.map((c) => `${c.heading}\n${c.body}`)].join('\n');
  const signals: RiskSignal[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) signals.push({ rule: p.rule, points: p.points, evidence: p.label });
  }
  if (!/confidential/i.test(text)) signals.push({ rule: 'confidentiality_absent', points: 10, evidence: 'no confidentiality clause found' });
  if ((meta.valueMinor ?? 0) >= 100_000_00) signals.push({ rule: 'high_value', points: 10, evidence: 'contract value >= 100,000 major units' });
  if ((meta.termMonths ?? 0) > 36) signals.push({ rule: 'long_term', points: 10, evidence: 'term longer than 36 months' });
  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  return { score, band: bandFor(score), signals };
}

/** Playbook deviation points: a major deviation (unacceptable wording or a
 * missing required clause) outweighs any single content pattern except
 * unlimited liability; a minor deviation (fallback wording only) is a nudge. */
export const DEVIATION_POINTS: Readonly<Record<'minor' | 'major', number>> = { minor: 5, major: 20 };

export function applyDeviations(assessment: RiskAssessment, deviations: readonly ClauseDeviation[]): RiskAssessment {
  const extra: RiskSignal[] = deviations
    .filter((d): d is ClauseDeviation & { severity: 'minor' | 'major' } => d.severity !== 'none')
    .map((d) => ({ rule: `playbook_deviation_${d.severity}`, points: DEVIATION_POINTS[d.severity], evidence: `${d.clauseKey}: ${d.detail}` }));
  if (extra.length === 0) return assessment;
  const signals = [...assessment.signals, ...extra];
  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  return { score, band: bandFor(score), signals };
}

export function assessWithDeviations(content: ContractContent, deviations: readonly ClauseDeviation[], meta: { valueMinor?: number; termMonths?: number } = {}): RiskAssessment {
  return applyDeviations(assessRisk(content, meta), deviations);
}

export function requiredApprovers(assessment: RiskAssessment, valueMinor = 0): Role[] {
  const roles = new Set<Role>(['approver']);
  if (assessment.band === 'high' || assessment.band === 'critical' || valueMinor >= 100_000_00) roles.add('counsel');
  if (assessment.band === 'critical') roles.add('admin');
  return [...roles];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export interface ApprovalRequest {
  readonly id: ApprovalId; readonly tenantId: TenantId; readonly contractId: ContractId;
  readonly requiredRoles: readonly Role[]; readonly status: ApprovalStatus;
  readonly decisions: readonly { userId: UserId; role: Role; decision: 'approved' | 'rejected'; at: string; note: string }[];
  readonly requestedBy: UserId; readonly requestedAt: string;
}

export class ApprovalService {
  #reqs = new Map<ApprovalId, ApprovalRequest>();
  readonly #clock: Clock; readonly #audit: AuditLog;
  constructor(deps: { clock: Clock; audit: AuditLog }) { this.#clock = deps.clock; this.#audit = deps.audit; }

  request(ctx: AccessContext, input: { contractId: ContractId; requiredRoles: readonly Role[] }): ApprovalRequest {
    requirePermission(ctx, 'contract:write');
    if (input.requiredRoles.length === 0) throw new DomainError('VALIDATION', 'at least one approver role required');
    const r: ApprovalRequest = {
      id: newApprovalId(), tenantId: ctx.tenantId, contractId: input.contractId,
      requiredRoles: input.requiredRoles, status: 'pending', decisions: [],
      requestedBy: ctx.userId, requestedAt: this.#clock.now().toISOString(),
    };
    this.#reqs.set(r.id, r);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'approval.requested', subjectType: 'contract', subjectId: input.contractId, detail: { approvalId: r.id, requiredRoles: input.requiredRoles } });
    return r;
  }
  decide(ctx: AccessContext, id: ApprovalId, decision: 'approved' | 'rejected', note = ''): ApprovalRequest {
    const r = this.#reqs.get(id);
    if (!r) throw new DomainError('NOT_FOUND', `approval not found: ${id}`);
    assertTenant(ctx, r.tenantId);
    requirePermission(ctx, 'contract:approve');
    if (r.status !== 'pending') throw new DomainError('CONFLICT', `approval already ${r.status}`);
    // Prefer a required role that is not yet satisfied, so a decider holding
    // several roles fills an open slot instead of duplicating a filled one.
    const satisfied = new Set(r.decisions.filter((d) => d.decision === 'approved').map((d) => d.role));
    const role = r.requiredRoles.find((x) => ctx.roles.includes(x) && !satisfied.has(x))
      ?? (ctx.roles.includes('admin') ? r.requiredRoles.find((x) => !satisfied.has(x)) : undefined)
      ?? r.requiredRoles.find((x) => ctx.roles.includes(x));
    if (!role) throw new DomainError('FORBIDDEN', 'decider holds none of the required roles', { requiredRoles: r.requiredRoles });
    if (r.decisions.some((d) => d.userId === ctx.userId)) throw new DomainError('CONFLICT', 'user already decided');
    const decisions = [...r.decisions, { userId: ctx.userId, role, decision, at: this.#clock.now().toISOString(), note }];
    let status: ApprovalStatus = 'pending';
    if (decision === 'rejected') status = 'rejected';
    else if (r.requiredRoles.every((role2) => decisions.some((d) => d.role === role2 && d.decision === 'approved'))) status = 'approved';
    const updated: ApprovalRequest = { ...r, decisions, status };
    this.#reqs.set(id, updated);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'approval.decided', subjectType: 'contract', subjectId: r.contractId, detail: { approvalId: id, decision, status } });
    return updated;
  }
  approvedFor(ctx: AccessContext, contractId: ContractId, requiredRoles: readonly Role[]): boolean {
    requirePermission(ctx, 'contract:read');
    return [...this.#reqs.values()].some((r) => r.tenantId === ctx.tenantId && r.contractId === contractId && r.status === 'approved'
      && requiredRoles.every((role) => r.requiredRoles.includes(role)));
  }
  get(ctx: AccessContext, id: ApprovalId): ApprovalRequest {
    const r = this.#reqs.get(id);
    if (!r) throw new DomainError('NOT_FOUND', `approval not found: ${id}`);
    assertTenant(ctx, r.tenantId);
    requirePermission(ctx, 'contract:read');
    return r;
  }
}
