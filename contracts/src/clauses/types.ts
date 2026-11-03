/** Clause & template management — shared types. A clause library holds
 * reusable, versioned clause templates; a contract template is an ordered
 * bundle of clause keys; a playbook records, per clause key, the preferred
 * wording, the acceptable fallback, and unacceptable wording, which the
 * deviation scorer in playbook.ts compares contract content against. All
 * records are tenant-scoped; an upsert of an existing key bumps version. */
import type { TenantId, UserId } from '../core/ids.ts';

export type ClauseRiskLevel = 'low' | 'medium' | 'high';

export interface ClauseTemplate {
  readonly id: string; readonly tenantId: TenantId; readonly key: string;
  readonly title: string; readonly body: string; readonly category: string;
  readonly riskLevel: ClauseRiskLevel; readonly version: number;
  readonly updatedBy: UserId; readonly updatedAt: string;
}

export interface ContractTemplate {
  readonly id: string; readonly tenantId: TenantId; readonly key: string;
  readonly title: string; readonly clauseKeys: readonly string[];
  readonly version: number; readonly updatedBy: UserId; readonly updatedAt: string;
}

export interface PlaybookPosition {
  readonly clauseKey: string; readonly preferred: string; readonly fallback: string;
  readonly unacceptable: string; readonly note: string;
}

export interface Playbook {
  readonly id: string; readonly tenantId: TenantId; readonly key: string;
  readonly title: string; readonly positions: readonly PlaybookPosition[];
  readonly version: number; readonly updatedBy: UserId; readonly updatedAt: string;
}

export type DeviationSeverity = 'none' | 'minor' | 'major';
export interface ClauseDeviation {
  readonly clauseKey: string; readonly severity: DeviationSeverity; readonly detail: string;
}
