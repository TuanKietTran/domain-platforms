import { DomainError } from '../core/errors.js';
import type { TenantId, TeamId, UserId } from '../core/ids.js';
import { deepFreeze, unique } from '../core/util.js';
import type { TicketChannel, TicketPriority } from '../tickets/types.js';

export interface RoutingRequest {
  readonly tenantId: TenantId;
  readonly channel: TicketChannel;
  readonly priority: TicketPriority;
  readonly tags: readonly string[];
  readonly subject: string;
  readonly description: string;
  readonly language?: string;
  readonly productId?: string;
  readonly requiredSkills?: readonly string[];
}

export interface RoutingConditions {
  readonly channels?: readonly TicketChannel[];
  readonly priorities?: readonly TicketPriority[];
  readonly tagsAny?: readonly string[];
  readonly tagsAll?: readonly string[];
  readonly languages?: readonly string[];
  readonly productIds?: readonly string[];
  readonly keywordsAny?: readonly string[];
  readonly keywordsAll?: readonly string[];
}

export interface RoutingRule {
  readonly id: string;
  readonly name?: string;
  readonly priority: number;
  readonly enabled?: boolean;
  readonly tenantId?: TenantId;
  readonly conditions?: RoutingConditions;
  readonly teamId?: TeamId;
  readonly assigneeId?: UserId;
  readonly candidateAssigneeIds?: readonly UserId[];
  readonly requiredSkills?: readonly string[];
  readonly setPriority?: TicketPriority;
  readonly addTags?: readonly string[];
  readonly reason?: string;
}

export interface RoutingAgent {
  readonly userId: UserId;
  readonly teamId?: TeamId;
  readonly skills?: readonly string[];
  readonly languages?: readonly string[];
  readonly channels?: readonly TicketChannel[];
  readonly capacity?: number;
  readonly active?: boolean;
}

export interface RoutingContext {
  readonly load?: ReadonlyMap<string, number>;
  readonly agents?: readonly RoutingAgent[];
}

export interface RoutingMatch {
  readonly ruleId: string;
  readonly reason: string;
}

export interface RoutingDecision {
  readonly priority: TicketPriority;
  readonly tags: readonly string[];
  readonly teamId?: TeamId;
  readonly assigneeId?: UserId;
  readonly matchedRules: readonly RoutingMatch[];
  readonly explanation: string;
}

export interface RoutingEngineOptions {
  readonly rules?: readonly RoutingRule[];
  readonly agents?: readonly RoutingAgent[];
}

function matchFacets(rule: RoutingRule, request: RoutingRequest): readonly string[] | undefined {
  const c = rule.conditions ?? {};
  const facets: string[] = [];
  if (c.channels?.length) {
    if (!c.channels.includes(request.channel)) return undefined;
    facets.push(`channel=${request.channel}`);
  }
  if (c.priorities?.length) {
    if (!c.priorities.includes(request.priority)) return undefined;
    facets.push(`priority=${request.priority}`);
  }
  if (c.tagsAny?.length) {
    if (!c.tagsAny.some((tag) => request.tags.includes(tag))) return undefined;
    facets.push(`tagsAny=${c.tagsAny.filter((tag) => request.tags.includes(tag)).join(',')}`);
  }
  if (c.tagsAll?.length) {
    if (!c.tagsAll.every((tag) => request.tags.includes(tag))) return undefined;
    facets.push(`tagsAll=${c.tagsAll.join(',')}`);
  }
  if (c.languages?.length) {
    if (!request.language || !c.languages.includes(request.language)) return undefined;
    facets.push(`language=${request.language}`);
  }
  if (c.productIds?.length) {
    if (!request.productId || !c.productIds.includes(request.productId)) return undefined;
    facets.push(`productId=${request.productId}`);
  }
  const text = `${request.subject}\n${request.description}`.toLowerCase();
  if (c.keywordsAny?.length) {
    const hit = c.keywordsAny.filter((word) => text.includes(word.toLowerCase()));
    if (hit.length === 0) return undefined;
    facets.push(`keywordsAny=${hit.join(',')}`);
  }
  if (c.keywordsAll?.length) {
    if (!c.keywordsAll.every((word) => text.includes(word.toLowerCase()))) return undefined;
    facets.push(`keywordsAll=${c.keywordsAll.join(',')}`);
  }
  return facets;
}

function leastLoaded(ids: readonly UserId[], load: ReadonlyMap<string, number>): UserId | undefined {
  return [...ids].sort((a, b) => {
    const diff = (load.get(a) ?? 0) - (load.get(b) ?? 0);
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

/**
 * Deterministic, explainable rule-based routing.
 * Rules are evaluated by priority (desc), then id (asc). The first matched
 * rule wins for team, priority override and explicit assignee; tags from all
 * matched rules accumulate. Agent choice is least-loaded (tie-break: userId
 * asc), filtered by team, required skills, language/channel and capacity.
 */
export class RoutingEngine {
  private readonly rules: RoutingRule[] = [];
  private readonly agents: RoutingAgent[] = [];

  constructor(options: RoutingEngineOptions | readonly RoutingRule[] = {}) {
    const opts: RoutingEngineOptions = Array.isArray(options) ? { rules: options as readonly RoutingRule[] } : (options as RoutingEngineOptions);
    for (const rule of opts.rules ?? []) this.registerRule(rule);
    for (const agent of opts.agents ?? []) this.registerAgent(agent);
  }

  registerRule(rule: RoutingRule): RoutingRule {
    if (!rule.id) throw new DomainError('VALIDATION', 'Routing rule requires an id');
    if (!Number.isFinite(rule.priority)) throw new DomainError('VALIDATION', 'Routing rule priority must be finite', { ruleId: rule.id });
    if (this.rules.some((existing) => existing.id === rule.id)) {
      throw new DomainError('VALIDATION', 'Duplicate routing rule id', { ruleId: rule.id });
    }
    const frozen = deepFreeze({ ...rule });
    this.rules.push(frozen);
    return frozen;
  }

  registerAgent(agent: RoutingAgent): RoutingAgent {
    const frozen = deepFreeze({ ...agent });
    this.agents.push(frozen);
    return frozen;
  }

  listRules(): readonly RoutingRule[] {
    return [...this.rules];
  }

  listAgents(): readonly RoutingAgent[] {
    return [...this.agents];
  }

  decide(request: RoutingRequest, context: RoutingContext = {}): RoutingDecision {
    const load = context.load ?? new Map<string, number>();
    const agents = context.agents ?? this.agents;
    const ordered = [...this.rules]
      .filter((rule) => rule.enabled !== false && (!rule.tenantId || rule.tenantId === request.tenantId))
      .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const matched: { rule: RoutingRule; facets: readonly string[] }[] = [];
    for (const rule of ordered) {
      const facets = matchFacets(rule, request);
      if (facets) matched.push({ rule, facets });
    }

    let priority = request.priority;
    let teamId: TeamId | undefined;
    let explicitAssignee: UserId | undefined;
    const candidates: UserId[] = [];
    const requiredSkills: string[] = [...(request.requiredSkills ?? [])];
    const tags: string[] = [...request.tags];
    for (const { rule } of matched) {
      if (rule.setPriority && priority === request.priority) priority = rule.setPriority;
      if (rule.teamId && !teamId) teamId = rule.teamId;
      if (rule.assigneeId && !explicitAssignee) explicitAssignee = rule.assigneeId;
      for (const id of rule.candidateAssigneeIds ?? []) if (!candidates.includes(id)) candidates.push(id);
      for (const skill of rule.requiredSkills ?? []) if (!requiredSkills.includes(skill)) requiredSkills.push(skill);
      for (const tag of rule.addTags ?? []) if (!tags.includes(tag)) tags.push(tag);
    }

    let assigneeId = explicitAssignee;
    if (!assigneeId && candidates.length > 0) {
      const eligible = candidates.filter((id) => {
        const agent = agents.find((entry) => entry.userId === id);
        return !agent || agent.active === false ? false : agent.capacity === undefined || (load.get(id) ?? 0) < agent.capacity;
      });
      assigneeId = leastLoaded(eligible.length > 0 ? eligible : candidates, load);
    }
    if (!assigneeId && agents.length > 0) {
      const eligible = agents.filter((agent) => {
        if (agent.active === false) return false;
        if (teamId && agent.teamId && agent.teamId !== teamId) return false;
        if (requiredSkills.length > 0 && !requiredSkills.every((skill) => agent.skills?.includes(skill))) return false;
        if (request.language && agent.languages?.length && !agent.languages.includes(request.language)) return false;
        if (agent.channels?.length && !agent.channels.includes(request.channel)) return false;
        if (agent.capacity !== undefined && (load.get(agent.userId) ?? 0) >= agent.capacity) return false;
        return true;
      });
      assigneeId = leastLoaded(eligible.map((agent) => agent.userId), load);
      if (assigneeId && !teamId) teamId = eligible.find((agent) => agent.userId === assigneeId)?.teamId ?? teamId;
    }

    const matchedRules: RoutingMatch[] = matched.map(({ rule, facets }) => ({
      ruleId: rule.id,
      reason: rule.reason ?? `Rule ${rule.id} matched${facets.length > 0 ? ` (${facets.join('; ')})` : ' (no conditions)'}`,
    }));
    const explanation =
      matchedRules.length > 0
        ? matchedRules.map((match) => match.reason).join(' | ') +
          ` => priority=${priority}, team=${teamId ?? 'none'}, assignee=${assigneeId ?? 'none'}`
        : 'No routing rules matched; ticket left unassigned with the requested priority and tags.';
    return deepFreeze({ priority, tags: unique(tags), teamId, assigneeId, matchedRules, explanation });
  }
}

export const RuleBasedRoutingEngine = RoutingEngine;
export const DefaultRoutingEngine = RoutingEngine;
