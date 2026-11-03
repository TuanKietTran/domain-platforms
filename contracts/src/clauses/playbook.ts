/** Playbooks + deviation scoring. A playbook records, per clause key, the
 * preferred wording, the acceptable fallback, and unacceptable wording.
 * Scoring contract content against it is deterministic: normalized
 * substring containment (case/whitespace-insensitive), and every deviation
 * names the clause key and why it scored that severity. No ML. */
import { DomainError } from '../core/errors.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext } from '../identity/index.ts';
import { requirePermission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';
import type { ContractContent } from '../versioning/index.ts';
import type { ClauseDeviation, Playbook, PlaybookPosition } from './types.ts';

const scope = (tenantId: string, key: string): string => `${tenantId}:${key}`;
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export class PlaybookService {
  #playbooks = new Map<string, Playbook>();
  readonly #clock: Clock; readonly #audit: AuditLog;
  constructor(deps: { clock: Clock; audit: AuditLog }) { this.#clock = deps.clock; this.#audit = deps.audit; }

  upsertPlaybook(ctx: AccessContext, input: { key: string; title: string; positions: readonly PlaybookPosition[] }): Playbook {
    requirePermission(ctx, 'contract:write');
    if (!input.key.trim() || !input.title.trim() || input.positions.length === 0)
      throw new DomainError('VALIDATION', 'playbook key, title and at least one position are required');
    for (const p of input.positions)
      if (!p.clauseKey.trim() || !p.preferred.trim() || !p.fallback.trim())
        throw new DomainError('VALIDATION', `position for clause ${p.clauseKey || '(blank)'} needs a clause key, preferred and fallback wording`);
    const id = scope(ctx.tenantId, input.key);
    const pb: Playbook = {
      id, tenantId: ctx.tenantId, key: input.key, title: input.title,
      positions: input.positions.map((p) => ({ ...p })),
      version: (this.#playbooks.get(id)?.version ?? 0) + 1,
      updatedBy: ctx.userId, updatedAt: this.#clock.now().toISOString(),
    };
    this.#playbooks.set(id, pb);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: pb.version === 1 ? 'playbook.created' : 'playbook.version.created', subjectType: 'playbook', subjectId: id, detail: { key: input.key, version: pb.version } });
    return pb;
  }
  getPlaybook(ctx: AccessContext, key: string): Playbook {
    requirePermission(ctx, 'contract:read');
    const pb = this.#playbooks.get(scope(ctx.tenantId, key));
    if (!pb) throw new DomainError('NOT_FOUND', `playbook not found: ${key}`);
    return pb;
  }
  listPlaybooks(ctx: AccessContext): readonly Playbook[] {
    requirePermission(ctx, 'contract:read');
    return [...this.#playbooks.values()].filter((p) => p.tenantId === ctx.tenantId);
  }
  assessDeviations(ctx: AccessContext, playbookKey: string, content: ContractContent): readonly ClauseDeviation[] {
    requirePermission(ctx, 'contract:read');
    const pb = this.getPlaybook(ctx, playbookKey);
    return pb.positions.map((p): ClauseDeviation => {
      const clause = content.clauses.find((c) => c.id === p.clauseKey);
      if (!clause) return { clauseKey: p.clauseKey, severity: 'major', detail: 'required clause missing from content' };
      const body = norm(`${clause.heading}\n${clause.body}`);
      if (p.unacceptable.trim() && body.includes(norm(p.unacceptable)))
        return { clauseKey: p.clauseKey, severity: 'major', detail: 'matches unacceptable wording' };
      if (body.includes(norm(p.preferred)))
        return { clauseKey: p.clauseKey, severity: 'none', detail: 'matches preferred position' };
      if (body.includes(norm(p.fallback)))
        return { clauseKey: p.clauseKey, severity: 'minor', detail: 'matches fallback position only' };
      return { clauseKey: p.clauseKey, severity: 'major', detail: 'matches neither preferred nor fallback position' };
    });
  }
}
