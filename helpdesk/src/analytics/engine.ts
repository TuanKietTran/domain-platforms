import { DomainError } from '../core/errors.js';
import type { TenantId } from '../core/ids.js';
import { deepFreeze, round } from '../core/util.js';
import type { TicketChannel, TicketPriority, TicketStatus } from '../tickets/types.js';

export interface TicketFact {
  readonly tenantId: TenantId;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly channel: TicketChannel;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly firstResponseAt?: string;
  readonly slaBreached?: boolean;
  readonly csatScore?: number;
  readonly assigneeId?: string;
  readonly teamId?: string;
}

export interface AnalyticsQuery {
  readonly tenantId: TenantId;
  readonly from?: string;
  readonly to?: string;
  readonly channel?: TicketChannel;
  readonly teamId?: string;
}

export interface AnalyticsReport {
  readonly tenantId: TenantId;
  readonly total: number;
  readonly open: number;
  readonly resolved: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byPriority: Readonly<Record<string, number>>;
  readonly byChannel: Readonly<Record<string, number>>;
  readonly byAssignee: Readonly<Record<string, number>>;
  readonly resolutionRate: number;
  readonly avgResolutionMinutes?: number;
  readonly avgFirstResponseMinutes?: number;
  readonly slaBreachRate: number;
  readonly csatAverage?: number;
}

export interface DailyCount { readonly date: string; readonly created: number; readonly resolved: number; }

function parseInstant(value: string, field: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new DomainError('VALIDATION', 'Invalid timestamp', { field, value });
  return ms;
}

function countBy(facts: readonly TicketFact[], key: (f: TicketFact) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const fact of facts) { const k = key(fact); if (k !== undefined) out[k] = (out[k] ?? 0) + 1; }
  return out;
}

function avgMinutes(facts: readonly TicketFact[], from: (f: TicketFact) => string, to: (f: TicketFact) => string | undefined): number | undefined {
  const spans: number[] = [];
  for (const fact of facts) { const end = to(fact); if (!end) continue; const minutes = (parseInstant(end, 'timestamp') - parseInstant(from(fact), 'createdAt')) / 60_000; if (minutes < 0) throw new DomainError('VALIDATION', 'Event timestamp precedes creation'); spans.push(minutes); }
  return spans.length ? round(spans.reduce((a, b) => a + b, 0) / spans.length) : undefined;
}

function select(facts: readonly TicketFact[], query: AnalyticsQuery): TicketFact[] {
  const from = query.from ? parseInstant(query.from, 'from') : undefined;
  const to = query.to ? parseInstant(query.to, 'to') : undefined;
  if (from !== undefined && to !== undefined && to <= from) throw new DomainError('VALIDATION', 'Query range is empty', { from: query.from, to: query.to });
  return facts.filter((f) => {
    if (f.tenantId !== query.tenantId) return false;
    if (query.channel && f.channel !== query.channel) return false;
    if (query.teamId && f.teamId !== query.teamId) return false;
    const created = parseInstant(f.createdAt, 'createdAt');
    if (from !== undefined && created < from) return false;
    if (to !== undefined && created >= to) return false;
    if (f.csatScore !== undefined && (f.csatScore < 1 || f.csatScore > 5)) throw new DomainError('VALIDATION', 'CSAT score must be between 1 and 5');
    return true;
  });
}

/** Pure aggregations over ticket facts: tenant-scoped, range-filtered, no storage. */
export class AnalyticsEngine {
  compute(facts: readonly TicketFact[], query: AnalyticsQuery): AnalyticsReport {
    const selected = select(facts, query);
    const total = selected.length;
    const resolvedFacts = selected.filter((f) => f.status === 'resolved' || f.status === 'closed');
    const open = selected.filter((f) => f.status !== 'resolved' && f.status !== 'closed').length;
    const csat = selected.filter((f) => f.csatScore !== undefined);
    return deepFreeze({
      tenantId: query.tenantId,
      total,
      open,
      resolved: resolvedFacts.length,
      byStatus: countBy(selected, (f) => f.status),
      byPriority: countBy(selected, (f) => f.priority),
      byChannel: countBy(selected, (f) => f.channel),
      byAssignee: countBy(selected, (f) => f.assigneeId),
      resolutionRate: total ? round((resolvedFacts.length / total) * 100) : 0,
      avgResolutionMinutes: avgMinutes(resolvedFacts, (f) => f.createdAt, (f) => f.resolvedAt),
      avgFirstResponseMinutes: avgMinutes(selected, (f) => f.createdAt, (f) => f.firstResponseAt),
      slaBreachRate: total ? round((selected.filter((f) => f.slaBreached).length / total) * 100) : 0,
      csatAverage: csat.length ? round(csat.reduce((sum, f) => sum + (f.csatScore ?? 0), 0) / csat.length) : undefined,
    });
  }

  dailyTrend(facts: readonly TicketFact[], query: AnalyticsQuery): readonly DailyCount[] {
    const selected = select(facts, query);
    const days = new Map<string, DailyCount & { created: number; resolved: number }>();
    const bucket = (date: string) => { let entry = days.get(date); if (!entry) { entry = { date, created: 0, resolved: 0 }; days.set(date, entry); } return entry; };
    for (const fact of selected) {
      bucket(fact.createdAt.slice(0, 10)).created += 1;
      if (fact.resolvedAt) bucket(fact.resolvedAt.slice(0, 10)).resolved += 1;
    }
    return deepFreeze([...days.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }
}
