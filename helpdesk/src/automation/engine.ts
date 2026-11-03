import { DomainError } from '../core/errors.js';
import type { TenantId, TeamId, UserId } from '../core/ids.js';
import { deepFreeze, unique } from '../core/util.js';
import type { TicketChannel, TicketPriority, TicketStatus } from '../tickets/types.js';

export type AutomationTrigger = 'ticket_created' | 'ticket_updated' | 'status_changed' | 'priority_changed' | 'sla_breached';

export interface AutomationConditions {
  readonly statuses?: readonly TicketStatus[];
  readonly channels?: readonly TicketChannel[];
  readonly priorities?: readonly TicketPriority[];
  readonly tagsAny?: readonly string[];
  readonly tagsAll?: readonly string[];
  readonly assigneeIds?: readonly string[];
  readonly keywordsAny?: readonly string[];
}

export interface AutomationActions {
  readonly setPriority?: TicketPriority;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  readonly teamId?: TeamId;
  readonly assigneeId?: UserId;
  readonly macroIds?: readonly string[];
  readonly notifyTemplateIds?: readonly string[];
}

export interface AutomationRule {
  readonly id: string;
  readonly name?: string;
  readonly tenantId?: TenantId;
  readonly trigger: AutomationTrigger;
  readonly priority: number;
  readonly enabled?: boolean;
  readonly conditions?: AutomationConditions;
  readonly actions: AutomationActions;
  readonly stopProcessing?: boolean;
}

export interface TicketSnapshot {
  readonly tenantId: TenantId;
  readonly status: TicketStatus;
  readonly channel: TicketChannel;
  readonly priority: TicketPriority;
  readonly tags: readonly string[];
  readonly subject: string;
  readonly description: string;
  readonly assigneeId?: string;
  readonly teamId?: TeamId;
}

export interface AutomationMatch { readonly ruleId: string; readonly reason: string; }

export interface AutomationDecision {
  readonly priority: TicketPriority;
  readonly tags: readonly string[];
  readonly teamId?: TeamId;
  readonly assigneeId?: UserId;
  readonly macroIds: readonly string[];
  readonly notifyTemplateIds: readonly string[];
  readonly matchedRules: readonly AutomationMatch[];
  readonly explanation: string;
}

export interface Macro {
  readonly id: string;
  readonly name: string;
  readonly tenantId?: TenantId;
  readonly actions: AutomationActions;
}

export interface MacroApplication {
  readonly macroId: string;
  readonly priority: TicketPriority;
  readonly tags: readonly string[];
  readonly teamId?: TeamId;
  readonly assigneeId?: UserId;
  readonly notifyTemplateIds: readonly string[];
}

interface MutableState { priority: TicketPriority; tags: string[]; teamId?: TeamId; assigneeId?: UserId; macroIds: string[]; notifyTemplateIds: string[]; }

function hasActions(actions: AutomationActions | undefined): boolean {
  return !!actions && (actions.setPriority !== undefined || (actions.addTags?.length ?? 0) > 0 || (actions.removeTags?.length ?? 0) > 0 || actions.teamId !== undefined || actions.assigneeId !== undefined || (actions.macroIds?.length ?? 0) > 0 || (actions.notifyTemplateIds?.length ?? 0) > 0);
}

function applyActions(state: MutableState, actions: AutomationActions): void {
  if (actions.setPriority) state.priority = actions.setPriority;
  if (actions.teamId) state.teamId = actions.teamId;
  if (actions.assigneeId) state.assigneeId = actions.assigneeId;
  if (actions.addTags?.length) state.tags = unique([...state.tags, ...actions.addTags]);
  if (actions.removeTags?.length) state.tags = state.tags.filter((tag) => !actions.removeTags!.includes(tag));
  if (actions.macroIds?.length) state.macroIds = unique([...state.macroIds, ...actions.macroIds]);
  if (actions.notifyTemplateIds?.length) state.notifyTemplateIds = unique([...state.notifyTemplateIds, ...actions.notifyTemplateIds]);
}

function matches(rule: AutomationRule, snapshot: TicketSnapshot): readonly string[] | undefined {
  const c = rule.conditions ?? {};
  const facets: string[] = [];
  if (c.statuses?.length) { if (!c.statuses.includes(snapshot.status)) return undefined; facets.push(`status=${snapshot.status}`); }
  if (c.channels?.length) { if (!c.channels.includes(snapshot.channel)) return undefined; facets.push(`channel=${snapshot.channel}`); }
  if (c.priorities?.length) { if (!c.priorities.includes(snapshot.priority)) return undefined; facets.push(`priority=${snapshot.priority}`); }
  if (c.tagsAny?.length) { if (!c.tagsAny.some((t) => snapshot.tags.includes(t))) return undefined; facets.push('tagsAny'); }
  if (c.tagsAll?.length) { if (!c.tagsAll.every((t) => snapshot.tags.includes(t))) return undefined; facets.push('tagsAll'); }
  if (c.assigneeIds?.length) { if (!snapshot.assigneeId || !c.assigneeIds.includes(snapshot.assigneeId)) return undefined; facets.push(`assignee=${snapshot.assigneeId}`); }
  if (c.keywordsAny?.length) { const text = `${snapshot.subject} ${snapshot.description}`.toLowerCase(); if (!c.keywordsAny.some((k) => text.includes(k.toLowerCase()))) return undefined; facets.push('keywordsAny'); }
  return facets;
}

/** Ordered, tenant-scoped automation rules plus a macro library. Pure decisions: callers apply the result. */
export class AutomationEngine {
  private readonly rules = new Map<string, AutomationRule>();
  private readonly macros = new Map<string, Macro>();

  constructor(rules: readonly AutomationRule[] = [], macros: readonly Macro[] = []) {
    for (const rule of rules) this.registerRule(rule);
    for (const macro of macros) this.registerMacro(macro);
  }

  registerRule(rule: AutomationRule): void {
    if (!rule.id || rule.id.trim().length < 2) throw new DomainError('VALIDATION', 'Automation rule requires an id');
    if (!Number.isFinite(rule.priority)) throw new DomainError('VALIDATION', 'Automation rule priority must be a finite number', { ruleId: rule.id });
    if (!hasActions(rule.actions)) throw new DomainError('VALIDATION', 'Automation rule requires at least one action', { ruleId: rule.id });
    if (this.rules.has(rule.id)) throw new DomainError('CONFLICT', 'Automation rule already registered', { ruleId: rule.id });
    this.rules.set(rule.id, rule);
  }

  registerMacro(macro: Macro): void {
    if (!macro.id || macro.id.trim().length < 2 || !macro.name?.trim()) throw new DomainError('VALIDATION', 'Macro requires an id and a name');
    if (!hasActions(macro.actions)) throw new DomainError('VALIDATION', 'Macro requires at least one action', { macroId: macro.id });
    if (this.macros.has(macro.id)) throw new DomainError('CONFLICT', 'Macro already registered', { macroId: macro.id });
    this.macros.set(macro.id, macro);
  }

  getMacro(macroId: string, tenantId?: TenantId): Macro {
    const macro = this.macros.get(macroId);
    if (!macro) throw new DomainError('NOT_FOUND', 'Macro not found', { macroId });
    if (tenantId && macro.tenantId && macro.tenantId !== tenantId) throw new DomainError('TENANT_MISMATCH', 'Macro belongs to another tenant', { macroId });
    return macro;
  }

  listRules(tenantId?: TenantId): readonly AutomationRule[] {
    return [...this.rules.values()].filter((r) => !tenantId || !r.tenantId || r.tenantId === tenantId).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  evaluate(trigger: AutomationTrigger, snapshot: TicketSnapshot): AutomationDecision {
    const state: MutableState = { priority: snapshot.priority, tags: [...snapshot.tags], teamId: snapshot.teamId, macroIds: [], notifyTemplateIds: [] };
    const matched: AutomationMatch[] = [];
    for (const rule of this.listRules(snapshot.tenantId)) {
      if (rule.enabled === false || rule.trigger !== trigger) continue;
      const facets = matches(rule, snapshot);
      if (!facets) continue;
      applyActions(state, rule.actions);
      matched.push({ ruleId: rule.id, reason: `Rule ${rule.id} matched on ${trigger}${facets.length ? ` (${facets.join('; ')})` : ' (no conditions)'}` });
      if (rule.stopProcessing) break;
    }
    const explanation = matched.length ? matched.map((m) => m.reason).join(' | ') + ` => priority=${state.priority}, tags=${state.tags.join(',') || 'none'}` : `No automation rules matched trigger ${trigger}; snapshot unchanged.`;
    return deepFreeze({ priority: state.priority, tags: state.tags, teamId: state.teamId, assigneeId: state.assigneeId, macroIds: state.macroIds, notifyTemplateIds: state.notifyTemplateIds, matchedRules: matched, explanation });
  }

  applyMacro(macroId: string, snapshot: TicketSnapshot): MacroApplication {
    const macro = this.getMacro(macroId, snapshot.tenantId);
    const state: MutableState = { priority: snapshot.priority, tags: [...snapshot.tags], teamId: snapshot.teamId, macroIds: [], notifyTemplateIds: [] };
    applyActions(state, macro.actions);
    return deepFreeze({ macroId: macro.id, priority: state.priority, tags: state.tags, teamId: state.teamId, assigneeId: state.assigneeId, notifyTemplateIds: state.notifyTemplateIds });
  }
}
