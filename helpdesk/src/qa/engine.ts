import { SystemClock, type Clock } from '../core/clock.js';
import { DomainError } from '../core/errors.js';
import { SequentialIdGenerator, type IdGenerator, type TenantId, type TicketId, type UserId } from '../core/ids.js';
import { deepFreeze } from '../core/util.js';

export interface QaCriterion {
  readonly id: string;
  readonly name: string;
  readonly weight: number;
  readonly maxScore: number;
}

export interface QaScorecard {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly criteria: readonly QaCriterion[];
  readonly passThreshold: number;
}

export interface QaEvaluationInput {
  readonly tenantId: TenantId;
  readonly scorecardId: string;
  readonly ticketId: TicketId;
  readonly agentId: UserId;
  readonly reviewerId: UserId;
  readonly scores: Readonly<Record<string, number>>;
  readonly notes?: string;
}

export interface QaCriterionResult {
  readonly criterionId: string;
  readonly score: number;
  readonly maxScore: number;
  readonly weight: number;
  readonly weightedPercentage: number;
}

export interface QaEvaluation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly scorecardId: string;
  readonly ticketId: TicketId;
  readonly agentId: UserId;
  readonly reviewerId: UserId;
  readonly results: readonly QaCriterionResult[];
  readonly percentage: number;
  readonly passed: boolean;
  readonly notes?: string;
  readonly createdAt: string;
}

export interface QaAgentSummary {
  readonly agentId: UserId;
  readonly evaluations: number;
  readonly averagePercentage: number;
  readonly passRate: number;
}

function round2(value: number): number { return Math.round(value * 100) / 100; }
function req(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new DomainError('VALIDATION', 'Field must be a non-empty string', { field });
  return value.trim();
}

/** QA scoring over registered scorecards: weighted per-criterion percentages, a pass threshold, and per-agent aggregates. */
export class QaEngine {
  private readonly scorecards = new Map<string, QaScorecard>();
  private readonly evaluations: QaEvaluation[] = [];
  constructor(
    private readonly ids: IdGenerator = new SequentialIdGenerator(),
    private readonly clock: Clock = new SystemClock(),
  ) {}

  registerScorecard(scorecard: QaScorecard): QaScorecard {
    req(scorecard.id, 'scorecard.id');
    req(scorecard.name, 'scorecard.name');
    if (this.scorecards.has(scorecard.id)) throw new DomainError('CONFLICT', 'Scorecard already registered', { scorecardId: scorecard.id });
    if (!Array.isArray(scorecard.criteria) || scorecard.criteria.length === 0) throw new DomainError('VALIDATION', 'Scorecard requires at least one criterion', { scorecardId: scorecard.id });
    const seen = new Set<string>();
    for (const criterion of scorecard.criteria) {
      req(criterion.id, 'criterion.id');
      if (seen.has(criterion.id)) throw new DomainError('VALIDATION', 'Duplicate criterion id', { criterionId: criterion.id });
      seen.add(criterion.id);
      if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) throw new DomainError('VALIDATION', 'Criterion weight must be positive', { criterionId: criterion.id });
      if (!Number.isFinite(criterion.maxScore) || criterion.maxScore <= 0) throw new DomainError('VALIDATION', 'Criterion maxScore must be positive', { criterionId: criterion.id });
    }
    if (!Number.isFinite(scorecard.passThreshold) || scorecard.passThreshold < 0 || scorecard.passThreshold > 100) throw new DomainError('VALIDATION', 'passThreshold must be between 0 and 100', { scorecardId: scorecard.id });
    const stored: QaScorecard = deepFreeze({ ...scorecard, criteria: scorecard.criteria.map((c) => ({ ...c })) });
    this.scorecards.set(stored.id, stored);
    return stored;
  }

  getScorecard(scorecardId: string): QaScorecard {
    const scorecard = this.scorecards.get(scorecardId);
    if (!scorecard) throw new DomainError('NOT_FOUND', 'Scorecard not registered', { scorecardId });
    return scorecard;
  }

  evaluate(input: QaEvaluationInput): QaEvaluation {
    const scorecard = this.getScorecard(input.scorecardId);
    if (scorecard.tenantId !== input.tenantId) throw new DomainError('TENANT_MISMATCH', 'Scorecard belongs to another tenant', { scorecardId: input.scorecardId });
    const known = new Set(scorecard.criteria.map((c) => c.id));
    for (const key of Object.keys(input.scores)) {
      if (!known.has(key)) throw new DomainError('VALIDATION', 'Score for unknown criterion', { criterionId: key });
    }
    let weightTotal = 0;
    let weightedTotal = 0;
    const results: QaCriterionResult[] = scorecard.criteria.map((criterion) => {
      const score = input.scores[criterion.id];
      if (score === undefined) throw new DomainError('VALIDATION', 'Missing score for criterion', { criterionId: criterion.id });
      if (!Number.isFinite(score) || score < 0 || score > criterion.maxScore) throw new DomainError('VALIDATION', 'Score out of range', { criterionId: criterion.id, score, maxScore: criterion.maxScore });
      const weightedPercentage = round2((score / criterion.maxScore) * criterion.weight);
      weightTotal += criterion.weight;
      weightedTotal += weightedPercentage;
      return { criterionId: criterion.id, score, maxScore: criterion.maxScore, weight: criterion.weight, weightedPercentage };
    });
    const percentage = round2((weightedTotal / weightTotal) * 100);
    const evaluation: QaEvaluation = deepFreeze({
      id: this.ids.next('qa'), tenantId: input.tenantId, scorecardId: scorecard.id, ticketId: input.ticketId,
      agentId: input.agentId, reviewerId: input.reviewerId, results, percentage,
      passed: percentage >= scorecard.passThreshold, notes: input.notes, createdAt: this.clock.now().toISOString(),
    });
    this.evaluations.push(evaluation);
    return evaluation;
  }

  list(tenantId: TenantId, agentId?: UserId): readonly QaEvaluation[] {
    return this.evaluations.filter((e) => e.tenantId === tenantId && (agentId === undefined || e.agentId === agentId));
  }

  summary(tenantId: TenantId, agentId: UserId): QaAgentSummary {
    const mine = this.list(tenantId, agentId);
    if (mine.length === 0) return deepFreeze({ agentId, evaluations: 0, averagePercentage: 0, passRate: 0 });
    const average = mine.reduce((sum, e) => sum + e.percentage, 0) / mine.length;
    const passed = mine.filter((e) => e.passed).length;
    return deepFreeze({ agentId, evaluations: mine.length, averagePercentage: round2(average), passRate: round2((passed / mine.length) * 100) });
  }
}
