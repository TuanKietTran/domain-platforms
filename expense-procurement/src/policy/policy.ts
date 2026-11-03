import { createHash } from 'node:crypto';
import { canonicalJson, deepFreeze } from '../core/canonical.js';
import { DomainError } from '../core/errors.js';
import type { IsoDate, IsoTimestamp, TenantId, UserId } from '../core/types.js';
import { isoDate, isoTimestamp } from '../core/types.js';
import type { Permission, RoleName } from '../identity/permissions.js';
import { conditionFacts, evaluateCondition, type ConditionTrace, type FactBag, type RuleCondition } from './conditions.js';

export type PolicySubject = 'expense' | 'requisition' | 'purchase_order' | 'invoice' | 'vendor';

export type Severity = 'block' | 'warn' | 'info';

export interface PolicyRule {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly severity: Severity;
  readonly appliesTo: PolicySubject;
  readonly condition: RuleCondition;
  /** Shown to the submitter when the rule matches. */
  readonly message: string;
  readonly remediation?: string;
  readonly tags?: readonly string[];
  /** Facts that must exist before the rule can be evaluated confidently. */
  readonly requiresFacts?: readonly string[];
}

export interface ApprovalStep {
  readonly name: string;
  /** A role, or the special manager-of-submitter step. */
  readonly role: RoleName | 'manager_of_submitter';
  readonly minApprovers: number;
  readonly slaHours: number;
  readonly escalateTo?: RoleName;
}

export interface ApprovalTier {
  readonly name: string;
  readonly when: RuleCondition;
  readonly steps: readonly ApprovalStep[];
}

export interface PolicyDocumentInput {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly version: number;
  readonly effectiveFrom?: IsoDate;
  readonly rules: readonly PolicyRule[];
  readonly approvalMatrix: readonly ApprovalTier[];
  readonly defaultApproval: readonly ApprovalStep[];
  readonly createdBy: UserId;
  readonly changeNote: string;
  readonly tags?: readonly string[];
}

export interface PolicyDocument extends PolicyDocumentInput {
  readonly policyId: string;
  readonly effectiveFrom: IsoDate;
  readonly status: 'draft' | 'active' | 'retired';
  readonly createdAt: IsoTimestamp;
  readonly hash: string;
}

export interface PolicyViolation {
  readonly code: string;
  readonly title: string;
  readonly severity: Severity;
  readonly message: string;
  readonly remediation?: string;
  readonly explanation: string;
  readonly trace: ConditionTrace;
  readonly facts: readonly string[];
  readonly tags: readonly string[];
}

export interface ApprovalPlan {
  readonly required: boolean;
  readonly steps: readonly ApprovalStep[];
  readonly tiers: readonly string[];
  readonly explanation: readonly string[];
}

export interface PolicyDecision {
  readonly decisionId: string;
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyHash: string;
  readonly subject: PolicySubject;
  readonly subjectId: string;
  readonly decidedAt: IsoTimestamp;
  readonly factsHash: string;
  readonly allowed: boolean;
  readonly violations: readonly PolicyViolation[];
  readonly warnings: readonly PolicyViolation[];
  readonly advisories: readonly PolicyViolation[];
  readonly rulesEvaluated: number;
  readonly approval: ApprovalPlan;
  readonly missingFacts: readonly string[];
}

export type PolicyStatus = PolicyDocument['status'];

function hashPolicy(doc: PolicyDocumentInput): string {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

function validateDocument(input: PolicyDocumentInput): void {
  if (!input.rules.length) throw new DomainError('RULE_INVALID', 'A policy needs at least one rule');
  if (!input.defaultApproval.length) throw new DomainError('RULE_INVALID', 'A policy needs a default approval path');
  const codes = new Set<string>();
  for (const rule of input.rules) {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(rule.code)) {
      throw new DomainError('RULE_INVALID', 'Rule codes must be uppercase identifiers', { code: rule.code });
    }
    if (codes.has(rule.code)) throw new DomainError('RULE_INVALID', 'Duplicate rule code', { code: rule.code });
    codes.add(rule.code);
    if (!rule.message.trim()) throw new DomainError('RULE_INVALID', 'Rule message is required', { code: rule.code });
  }
  for (const tier of input.approvalMatrix) {
    if (!tier.name.trim()) throw new DomainError('RULE_INVALID', 'Approval tier name is required');
    for (const step of tier.steps) {
      if (step.minApprovers < 1) throw new DomainError('RULE_INVALID', 'Approval steps need at least one approver', { step: step.name });
      if (step.slaHours < 1) throw new DomainError('RULE_INVALID', 'Approval SLA must be positive', { step: step.name });
    }
  }
}

/**
 * Versioned policy registry.
 *
 * Documents are immutable once created. Activation retires the previous active
 * version for the tenant, and every decision records the exact version and
 * content hash it was made under, so a historical decision can always be
 * re-explained even after the rules change.
 */
export class PolicyRegistry {
  private readonly versions = new Map<string, PolicyDocument>();
  private readonly byTenant = new Map<TenantId, string[]>();
  private readonly activeByTenant = new Map<TenantId, string>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly nextId: () => string = (() => {
      let counter = 0;
      return () => `pol_${String(++counter).padStart(4, '0')}`;
    })(),
  ) {}

  createDraft(input: PolicyDocumentInput): PolicyDocument {
    validateDocument(input);
    for (const existing of this.versions.values()) {
      if (existing.tenantId === input.tenantId && existing.version === input.version) {
        throw new DomainError('CONFLICT', 'Policy version already exists for tenant', { version: input.version });
      }
    }
    const document: PolicyDocument = deepFreeze({
      ...input,
      policyId: this.nextId(),
      effectiveFrom: input.effectiveFrom ?? isoDate(isoTimestamp(this.now()).slice(0, 10)),
      status: 'draft',
      createdAt: isoTimestamp(this.now()),
      hash: hashPolicy(input),
    });
    this.versions.set(document.policyId, document);
    this.byTenant.set(input.tenantId, [...(this.byTenant.get(input.tenantId) ?? []), document.policyId]);
    return document;
  }

  activate(tenantId: TenantId, policyId: string): PolicyDocument {
    const draft = this.require(policyId);
    if (draft.tenantId !== tenantId) throw new DomainError('TENANT_MISMATCH', 'Policy belongs to another tenant');
    if (draft.status !== 'draft') throw new DomainError('STATE_INVALID', 'Only draft policies can be activated', { status: draft.status });
    const previousId = this.activeByTenant.get(tenantId);
    if (previousId) {
      const previous = this.versions.get(previousId);
      if (previous) this.versions.set(previousId, deepFreeze({ ...previous, status: 'retired' as const }));
    }
    const active: PolicyDocument = deepFreeze({ ...draft, status: 'active' as const });
    this.versions.set(policyId, active);
    this.activeByTenant.set(tenantId, policyId);
    return active;
  }

  active(tenantId: TenantId): PolicyDocument {
    const id = this.activeByTenant.get(tenantId);
    if (!id) throw new DomainError('RULE_INVALID', 'No active policy for tenant', { tenantId });
    return this.require(id);
  }

  maybeActive(tenantId: TenantId): PolicyDocument | undefined {
    const id = this.activeByTenant.get(tenantId);
    return id ? this.versions.get(id) : undefined;
  }

  require(policyId: string): PolicyDocument {
    const document = this.versions.get(policyId);
    if (!document) throw new DomainError('NOT_FOUND', 'Policy not found', { policyId });
    return document;
  }

  history(tenantId: TenantId): readonly PolicyDocument[] {
    return (this.byTenant.get(tenantId) ?? []).map((id) => this.versions.get(id)!).filter(Boolean);
  }

  activeHash(tenantId: TenantId): string {
    return this.active(tenantId).hash;
  }
}

let decisionCounter = 0;

export class PolicyEngine {
  constructor(
    private readonly registry: PolicyRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Evaluate the active policy for a tenant. Deterministic given policy
   * version, facts and subject identity: no clocks, random values or ambient
   * state influence the verdict.
   */
  evaluate(input: {
    readonly tenantId: TenantId;
    readonly subject: PolicySubject;
    readonly subjectId: string;
    readonly facts: FactBag;
    readonly policyId?: string;
  }): PolicyDecision {
    const document = input.policyId ? this.registry.require(input.policyId) : this.registry.active(input.tenantId);
    if (document.tenantId !== input.tenantId) throw new DomainError('TENANT_MISMATCH', 'Policy belongs to another tenant');
    if (document.status !== 'active' && document.status !== 'retired') {
      throw new DomainError('STATE_INVALID', 'Cannot evaluate a draft policy', { policyId: document.policyId });
    }
    const facts = deepFreeze({ ...input.facts });
    const violations: PolicyViolation[] = [];
    const warnings: PolicyViolation[] = [];
    const advisories: PolicyViolation[] = [];
    const missing = new Set<string>();
    let evaluated = 0;

    for (const rule of document.rules) {
      if (rule.appliesTo !== input.subject) continue;
      evaluated += 1;
      for (const required of rule.requiresFacts ?? []) {
        if (facts[required] === undefined) missing.add(required);
      }
      const trace = evaluateCondition(rule.condition, facts);
      if (!trace.result) continue;
      const violation: PolicyViolation = deepFreeze({
        code: rule.code,
        title: rule.title,
        severity: rule.severity,
        message: rule.message,
        ...(rule.remediation ? { remediation: rule.remediation } : {}),
        explanation: trace.explanation,
        trace,
        facts: [...conditionFacts(rule.condition)].sort(),
        tags: Object.freeze([...(rule.tags ?? [])]),
      });
      if (rule.severity === 'block') violations.push(violation);
      else if (rule.severity === 'warn') warnings.push(violation);
      else advisories.push(violation);
    }

    const approval = this.resolveApproval(document, facts);
    return deepFreeze({
      decisionId: `dec_${input.tenantId}_${input.subjectId}_${String(++decisionCounter).padStart(6, '0')}`,
      tenantId: input.tenantId,
      policyId: document.policyId,
      policyVersion: document.version,
      policyHash: document.hash,
      subject: input.subject,
      subjectId: input.subjectId,
      decidedAt: isoTimestamp(this.now()),
      factsHash: createHash('sha256').update(canonicalJson(facts)).digest('hex'),
      allowed: violations.length === 0,
      violations: Object.freeze(violations),
      warnings: Object.freeze(warnings),
      advisories: Object.freeze(advisories),
      rulesEvaluated: evaluated,
      approval,
      missingFacts: Object.freeze([...missing].sort()),
    });
  }

  /** Resolve the approval matrix: every matching tier contributes its steps. */
  resolveApproval(document: PolicyDocument, facts: FactBag): ApprovalPlan {
    const matchedTiers: string[] = [];
    const steps: ApprovalStep[] = [];
    const explanation: string[] = [];
    for (const tier of document.approvalMatrix) {
      const trace = evaluateCondition(tier.when, facts);
      if (!trace.result) continue;
      matchedTiers.push(tier.name);
      explanation.push(`Tier "${tier.name}" applies: ${trace.explanation}`);
      for (const step of tier.steps) steps.push(step);
    }
    if (steps.length === 0) {
      explanation.push('No matrix tier matched; the default approval path applies.');
      for (const step of document.defaultApproval) steps.push(step);
    }
    const merged = new Map<string, ApprovalStep>();
    for (const step of steps) {
      const key = `${step.name}:${step.role}`;
      const existing = merged.get(key);
      if (existing) {
        merged.set(key, {
          ...existing,
          minApprovers: Math.max(existing.minApprovers, step.minApprovers),
          slaHours: Math.min(existing.slaHours, step.slaHours),
        });
      } else {
        merged.set(key, step);
      }
    }
    const finalSteps = [...merged.values()];
    for (const step of finalSteps) {
      explanation.push(
        `Step "${step.name}": ${step.minApprovers} approver(s) from ${step.role}, SLA ${step.slaHours}h${step.escalateTo ? `, escalate to ${step.escalateTo}` : ''}`,
      );
    }
    return deepFreeze({
      required: finalSteps.length > 0,
      steps: Object.freeze(finalSteps),
      tiers: Object.freeze(matchedTiers),
      explanation: Object.freeze(explanation),
    });
  }

  /** Permission a human needs to override a blocking rule, if allowed. */
  overridePermission(rule: PolicyViolation): Permission {
    if (rule.severity === 'block') return 'expense.override';
    return 'expense.read.own';
  }
}
