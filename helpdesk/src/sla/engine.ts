import { DomainError } from '../core/errors.js';
import { deepFreeze } from '../core/util.js';
import type { TicketPriority } from '../tickets/types.js';

export type SlaTargetKind = 'first_response' | 'next_response' | 'resolution';

export interface BusinessCalendar {
  readonly workingDays: readonly number[];
  readonly startHour: number;
  readonly endHour: number;
  readonly holidays?: readonly string[];
  /** False only for a 24/7 calendar (see ALWAYS_ON); undefined means business hours. */
  readonly businessHours?: boolean;
}

export const DEFAULT_CALENDAR: BusinessCalendar = deepFreeze({
  workingDays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 17,
  holidays: [],
  businessHours: true,
});

export const ALWAYS_ON: BusinessCalendar = deepFreeze({
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  startHour: 0,
  endHour: 24,
  holidays: [],
  businessHours: false,
});

export interface SlaTarget {
  readonly kind: SlaTargetKind;
  readonly minutes: number;
}

export interface SlaPolicy {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly priority: TicketPriority | 'default';
  readonly targets: readonly SlaTarget[];
  readonly businessHours: boolean;
  readonly pauseOnPendingCustomer: boolean;
}

export interface SlaTargetState {
  readonly kind: SlaTargetKind;
  readonly minutes: number;
  readonly dueAt: string;
  readonly metAt?: string;
  readonly breachedAt?: string;
  readonly remainingMinutesAtPause?: number;
}

export interface SlaTracker {
  readonly policyId: string;
  readonly policyName: string;
  readonly priority: TicketPriority;
  readonly startedAt: string;
  readonly pausedAt?: string;
  readonly pauseReason?: string;
  readonly pausedMinutes: number;
  readonly businessHours: boolean;
  readonly targets: readonly SlaTargetState[];
  readonly breachNotified: readonly SlaTargetKind[];
}

export type SlaTargetStatus = 'met' | 'breached' | 'at_risk' | 'pending';

export interface SlaEvaluation {
  readonly kind: SlaTargetKind;
  readonly dueAt: string;
  readonly status: SlaTargetStatus;
  readonly remainingMinutes: number;
  readonly elapsedMinutes: number;
  readonly explanation: string;
}

export interface SlaBreach {
  readonly kind: SlaTargetKind;
  readonly dueAt: string;
  readonly minutesLate: number;
}

const MINUTE = 60_000;

function minutesToMs(minutes: number): number {
  return minutes * MINUTE;
}

function toMinutes(ms: number): number {
  return Math.round((ms / MINUTE) * 100) / 100;
}

function isWorkingDay(date: Date, calendar: BusinessCalendar): boolean {
  if (calendar.holidays?.includes(date.toISOString().slice(0, 10))) return false;
  return calendar.workingDays.includes(date.getUTCDay());
}

/** Adds business minutes to an instant, skipping non-working days and hours. */
export function addBusinessMinutes(from: Date | string, minutes: number, calendar: BusinessCalendar = DEFAULT_CALENDAR): Date {
  if (minutes < 0) throw new DomainError('VALIDATION', 'SLA minutes cannot be negative', { minutes });
  if (calendar.businessHours === false) {
    return new Date(new Date(from).getTime() + minutesToMs(minutes));
  }
  let remaining = minutes;
  const cursor = new Date(from);
  let guard = 0;
  while (remaining > 0) {
    guard += 1;
    if (guard > 100_000) throw new DomainError('VALIDATION', 'SLA calendar iteration limit reached');
    if (!isWorkingDay(cursor, calendar)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(calendar.startHour, 0, 0, 0);
      continue;
    }
    const hour = cursor.getUTCHours();
    const minute = cursor.getUTCMinutes();
    if (hour < calendar.startHour) {
      cursor.setUTCHours(calendar.startHour, 0, 0, 0);
      continue;
    }
    if (hour >= calendar.endHour) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(calendar.startHour, 0, 0, 0);
      continue;
    }
    const available = (calendar.endHour - hour) * 60 - minute;
    if (remaining <= available) {
      cursor.setTime(cursor.getTime() + minutesToMs(remaining));
      remaining = 0;
      break;
    }
    remaining -= available;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(calendar.startHour, 0, 0, 0);
  }
  return cursor;
}

/** Business minutes between two instants; never negative. */
export function businessMinutesBetween(
  from: Date | string,
  to: Date | string,
  calendar: BusinessCalendar = DEFAULT_CALENDAR,
): number {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (end <= start) return 0;
  if (calendar.businessHours === false) return toMinutes(end - start);

  let total = 0;
  const cursor = new Date(start);
  let guard = 0;
  while (cursor.getTime() < end) {
    guard += 1;
    if (guard > 100_000) break;
    if (!isWorkingDay(cursor, calendar)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(calendar.startHour, 0, 0, 0);
      continue;
    }
    const dayStart = new Date(cursor);
    dayStart.setUTCHours(calendar.startHour, 0, 0, 0);
    const dayEnd = new Date(cursor);
    dayEnd.setUTCHours(calendar.endHour, 0, 0, 0);
    const segmentStart = Math.max(cursor.getTime(), dayStart.getTime());
    const segmentEnd = Math.min(end, dayEnd.getTime());
    if (segmentEnd > segmentStart) total += segmentEnd - segmentStart;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(calendar.startHour, 0, 0, 0);
  }
  return toMinutes(total);
}

export interface SlaEngineOptions {
  readonly calendar?: BusinessCalendar;
  readonly atRiskRatio?: number;
}

/**
 * Deterministic SLA engine. Targets are created once at policy application and
 * deadlines are recomputed only at explicit pause/resume boundaries, which
 * keeps every decision explainable and reproducible.
 */
export class SlaEngine {
  private readonly policies = new Map<string, SlaPolicy>();
  private readonly calendar: BusinessCalendar;
  private readonly atRiskRatio: number;

  constructor(options: SlaEngineOptions = {}) {
    this.calendar = options.calendar ?? DEFAULT_CALENDAR;
    this.atRiskRatio = options.atRiskRatio ?? 0.25;
  }

  registerPolicy(policy: SlaPolicy): SlaPolicy {
    if (policy.targets.length === 0) {
      throw new DomainError('VALIDATION', 'SLA policy requires at least one target', { policyId: policy.id });
    }
    for (const target of policy.targets) {
      if (!Number.isFinite(target.minutes) || target.minutes <= 0) {
        throw new DomainError('VALIDATION', 'SLA target minutes must be positive', { policyId: policy.id, kind: target.kind });
      }
    }
    const kinds = new Set(policy.targets.map((target) => target.kind));
    if (kinds.size !== policy.targets.length) {
      throw new DomainError('VALIDATION', 'SLA policy has duplicate target kinds', { policyId: policy.id });
    }
    const frozen = deepFreeze({ ...policy, targets: [...policy.targets] });
    this.policies.set(policy.id, frozen);
    return frozen;
  }

  getPolicy(policyId: string): SlaPolicy {
    const policy = this.policies.get(policyId);
    if (!policy) throw new DomainError('NOT_FOUND', 'SLA policy not found', { policyId });
    return policy;
  }

  listPolicies(tenantId: string): readonly SlaPolicy[] {
    return [...this.policies.values()].filter((policy) => policy.tenantId === tenantId);
  }

  selectPolicy(tenantId: string, priority: TicketPriority): SlaPolicy {
    const candidates = this.listPolicies(tenantId);
    const exact = candidates.find((policy) => policy.priority === priority);
    const fallback = candidates.find((policy) => policy.priority === 'default');
    if (!exact && !fallback) {
      throw new DomainError('NOT_FOUND', 'No SLA policy configured for priority', { tenantId, priority });
    }
    return exact ?? (fallback as SlaPolicy);
  }

  private calendarFor(businessHours: boolean): BusinessCalendar {
    return businessHours ? this.calendar : ALWAYS_ON;
  }

  createTracker(policy: SlaPolicy, priority: TicketPriority, startedAt: string): SlaTracker {
    const calendar = this.calendarFor(policy.businessHours);
    const targets: SlaTargetState[] = policy.targets.map((target) => ({
      kind: target.kind,
      minutes: target.minutes,
      dueAt: addBusinessMinutes(startedAt, target.minutes, calendar).toISOString(),
    }));
    return deepFreeze({
      policyId: policy.id,
      policyName: policy.name,
      priority,
      startedAt,
      pausedMinutes: 0,
      businessHours: policy.businessHours,
      targets,
      breachNotified: [],
    });
  }

  pause(tracker: SlaTracker, at: string, reason: string): SlaTracker {
    if (tracker.pausedAt) return tracker;
    const calendar = this.calendarFor(tracker.businessHours);
    const targets = tracker.targets.map((target) => ({
      ...target,
      remainingMinutesAtPause: businessMinutesBetween(at, target.dueAt, calendar),
    }));
    return deepFreeze({ ...tracker, pausedAt: at, pauseReason: reason, targets });
  }

  resume(tracker: SlaTracker, at: string): SlaTracker {
    if (!tracker.pausedAt) return tracker;
    const calendar = this.calendarFor(tracker.businessHours);
    const pausedMinutes = tracker.pausedMinutes + businessMinutesBetween(tracker.pausedAt, at, calendar);
    const targets = tracker.targets.map((target) => ({
      ...target,
      dueAt: addBusinessMinutes(at, target.remainingMinutesAtPause ?? target.minutes, calendar).toISOString(),
      remainingMinutesAtPause: undefined,
    }));
    return deepFreeze({
      ...tracker,
      pausedAt: undefined,
      pauseReason: undefined,
      pausedMinutes: Math.round(pausedMinutes * 100) / 100,
      targets,
    });
  }

  markMet(tracker: SlaTracker, kind: SlaTargetKind, at: string): SlaTracker {
    const targets = tracker.targets.map((target) =>
      target.kind === kind && !target.metAt && !target.breachedAt ? { ...target, metAt: at } : target,
    );
    return deepFreeze({ ...tracker, targets });
  }

  reopenTarget(tracker: SlaTracker, kind: SlaTargetKind, at: string): SlaTracker {
    if (!tracker.targets.some((target) => target.kind === kind)) return tracker;
    const calendar = this.calendarFor(tracker.businessHours);
    const targets = tracker.targets.map((target) =>
      target.kind === kind
        ? {
            ...target,
            dueAt: addBusinessMinutes(at, target.minutes, calendar).toISOString(),
            metAt: undefined,
            breachedAt: undefined,
            remainingMinutesAtPause: tracker.pausedAt ? target.minutes : undefined,
          }
        : target,
    );
    const breachNotified = tracker.breachNotified.filter((notified) => notified !== kind);
    return deepFreeze({ ...tracker, targets, breachNotified });
  }

  evaluate(tracker: SlaTracker, at: string): readonly SlaEvaluation[] {
    const now = new Date(at).getTime();
    const calendar = this.calendarFor(tracker.businessHours);
    return tracker.targets.map((target) => {
      const due = new Date(target.dueAt).getTime();
      const remainingMinutes = toMinutes(due - now);
      if (target.metAt) {
        return {
          kind: target.kind,
          dueAt: target.dueAt,
          status: 'met' as const,
          remainingMinutes,
          elapsedMinutes: businessMinutesBetween(tracker.startedAt, target.metAt, calendar),
          explanation: `Met at ${target.metAt}, ${Math.max(0, toMinutes(due - new Date(target.metAt).getTime()))} minutes before the deadline`,
        };
      }
      if (target.breachedAt || tracker.pausedAt) {
        const status = target.breachedAt ? ('breached' as const) : ('pending' as const);
        return {
          kind: target.kind,
          dueAt: target.dueAt,
          status,
          remainingMinutes,
          elapsedMinutes: businessMinutesBetween(tracker.startedAt, target.breachedAt ?? tracker.pausedAt ?? at, calendar),
          explanation: target.breachedAt
            ? `Breached at ${target.breachedAt}`
            : `Paused at ${tracker.pausedAt}: ${tracker.pauseReason ?? 'waiting'}`,
        };
      }
      const elapsedMinutes = businessMinutesBetween(tracker.startedAt, at, calendar);
      const total = target.minutes;
      const ratio = total === 0 ? 0 : remainingMinutes / total;
      const status: SlaTargetStatus = remainingMinutes < 0 ? 'breached' : ratio <= this.atRiskRatio ? 'at_risk' : 'pending';
      const explanation =
        remainingMinutes < 0
          ? `${Math.abs(remainingMinutes)} minutes past a ${total} minute target`
          : `${remainingMinutes} of ${total} minutes remaining`;
      return {
        kind: target.kind,
        dueAt: target.dueAt,
        status,
        remainingMinutes,
        elapsedMinutes,
        explanation,
      };
    });
  }

  breaches(tracker: SlaTracker, at: string): readonly SlaBreach[] {
    const now = new Date(at).getTime();
    return tracker.targets
      .filter((target) => !target.metAt && !target.breachedAt && new Date(target.dueAt).getTime() < now)
      .map((target) => ({
        kind: target.kind,
        dueAt: target.dueAt,
        minutesLate: toMinutes(now - new Date(target.dueAt).getTime()),
      }));
  }

  recordBreach(tracker: SlaTracker, kind: SlaTargetKind, at: string): SlaTracker {
    const targets = tracker.targets.map((target) =>
      target.kind === kind && !target.breachedAt ? { ...target, breachedAt: at } : target,
    );
    const breachNotified = tracker.breachNotified.includes(kind)
      ? tracker.breachNotified
      : [...tracker.breachNotified, kind];
    return deepFreeze({ ...tracker, targets, breachNotified });
  }
}
