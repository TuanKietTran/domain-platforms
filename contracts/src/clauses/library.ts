/** Clause + contract-template library. Tenant-scoped, permission-checked,
 * audited, versioned by upsert. A template references clauses by key and
 * may only reference clauses that exist in the same tenant's library, so a
 * template can always be materialized into ContractContent (clause key
 * becomes the clause id, which is what playbook positions key on). */
import { DomainError } from '../core/errors.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext } from '../identity/index.ts';
import { requirePermission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';
import type { ContractContent } from '../versioning/index.ts';
import type { ClauseRiskLevel, ClauseTemplate, ContractTemplate } from './types.ts';

const scope = (tenantId: string, key: string): string => `${tenantId}:${key}`;

export class ClauseLibrary {
  #clauses = new Map<string, ClauseTemplate>();
  #templates = new Map<string, ContractTemplate>();
  readonly #clock: Clock; readonly #audit: AuditLog;
  constructor(deps: { clock: Clock; audit: AuditLog }) { this.#clock = deps.clock; this.#audit = deps.audit; }

  upsertClause(ctx: AccessContext, input: { key: string; title: string; body: string; category: string; riskLevel: ClauseRiskLevel }): ClauseTemplate {
    requirePermission(ctx, 'contract:write');
    if (!input.key.trim() || !input.title.trim() || !input.body.trim())
      throw new DomainError('VALIDATION', 'clause key, title and body are required');
    const id = scope(ctx.tenantId, input.key);
    const c: ClauseTemplate = {
      id, tenantId: ctx.tenantId, key: input.key, title: input.title, body: input.body,
      category: input.category, riskLevel: input.riskLevel,
      version: (this.#clauses.get(id)?.version ?? 0) + 1,
      updatedBy: ctx.userId, updatedAt: this.#clock.now().toISOString(),
    };
    this.#clauses.set(id, c);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: c.version === 1 ? 'clause.created' : 'clause.version.created', subjectType: 'clause', subjectId: id, detail: { key: input.key, version: c.version } });
    return c;
  }
  getClause(ctx: AccessContext, key: string): ClauseTemplate {
    requirePermission(ctx, 'contract:read');
    const c = this.#clauses.get(scope(ctx.tenantId, key));
    if (!c) throw new DomainError('NOT_FOUND', `clause not found: ${key}`);
    return c;
  }
  listClauses(ctx: AccessContext, category?: string): readonly ClauseTemplate[] {
    requirePermission(ctx, 'contract:read');
    return [...this.#clauses.values()].filter((c) => c.tenantId === ctx.tenantId && (category === undefined || c.category === category));
  }
  upsertTemplate(ctx: AccessContext, input: { key: string; title: string; clauseKeys: readonly string[] }): ContractTemplate {
    requirePermission(ctx, 'contract:write');
    if (!input.key.trim() || !input.title.trim() || input.clauseKeys.length === 0)
      throw new DomainError('VALIDATION', 'template key, title and at least one clause key are required');
    const missing = input.clauseKeys.filter((k) => !this.#clauses.has(scope(ctx.tenantId, k)));
    if (missing.length > 0) throw new DomainError('VALIDATION', `template references unknown clauses: ${missing.join(', ')}`, { missing });
    const id = scope(ctx.tenantId, input.key);
    const t: ContractTemplate = {
      id, tenantId: ctx.tenantId, key: input.key, title: input.title,
      clauseKeys: [...input.clauseKeys],
      version: (this.#templates.get(id)?.version ?? 0) + 1,
      updatedBy: ctx.userId, updatedAt: this.#clock.now().toISOString(),
    };
    this.#templates.set(id, t);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: t.version === 1 ? 'template.created' : 'template.version.created', subjectType: 'template', subjectId: id, detail: { key: input.key, version: t.version } });
    return t;
  }
  getTemplate(ctx: AccessContext, key: string): ContractTemplate {
    requirePermission(ctx, 'contract:read');
    const t = this.#templates.get(scope(ctx.tenantId, key));
    if (!t) throw new DomainError('NOT_FOUND', `template not found: ${key}`);
    return t;
  }
  listTemplates(ctx: AccessContext): readonly ContractTemplate[] {
    requirePermission(ctx, 'contract:read');
    return [...this.#templates.values()].filter((t) => t.tenantId === ctx.tenantId);
  }
  materialize(ctx: AccessContext, templateKey: string): ContractContent {
    const t = this.getTemplate(ctx, templateKey);
    return {
      title: t.title,
      clauses: t.clauseKeys.map((k) => { const c = this.getClause(ctx, k); return { id: c.key, heading: c.title, body: c.body }; }),
    };
  }
}
