import type { CustomerId, TeamId, TicketId, TenantId, UserId } from '../core/ids.js';
import type { SlaTracker } from '../sla/engine.js';

export type TicketStatus =
  | 'new'
  | 'triaged'
  | 'in_progress'
  | 'pending_customer'
  | 'pending_third_party'
  | 'resolved'
  | 'closed';

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TicketChannel = 'email' | 'chat' | 'web' | 'api' | 'phone';

export type TicketAction =
  | 'triage'
  | 'start'
  | 'request_customer_info'
  | 'request_third_party'
  | 'resume'
  | 'resolve'
  | 'close'
  | 'cancel'
  | 'reopen';

export type MessageVisibility = 'public' | 'internal';

export type MessageAuthorKind = 'customer' | 'agent' | 'system' | 'agent_assistant';

export interface TicketMessage {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly tenantId: TenantId;
  readonly authorKind: MessageAuthorKind;
  readonly authorId: string;
  readonly visibility: MessageVisibility;
  readonly body: string;
  readonly createdAt: string;
  readonly channel: TicketChannel;
  readonly citations?: readonly { articleId: string; version: number }[];
}

export interface TicketTransitionRecord {
  readonly action: TicketAction;
  readonly from: TicketStatus;
  readonly to: TicketStatus;
  readonly at: string;
  readonly actorId: string;
  readonly reason?: string;
}

export interface Ticket {
  readonly id: TicketId;
  readonly tenantId: TenantId;
  readonly number: number;
  readonly subject: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly channel: TicketChannel;
  readonly requesterId: CustomerId;
  readonly assigneeId?: UserId;
  readonly teamId?: TeamId;
  readonly tags: readonly string[];
  readonly language: string;
  readonly productId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly firstResponseAt?: string;
  readonly lastCustomerMessageAt?: string;
  readonly lastAgentMessageAt?: string;
  readonly resolvedAt?: string;
  readonly closedAt?: string;
  readonly reopenCount: number;
  readonly version: number;
  readonly sla?: SlaTracker;
  readonly resolutionSummary?: string;
  readonly transitions: readonly TicketTransitionRecord[];
  readonly customFields: Readonly<Record<string, string | number | boolean>>;
  readonly mergedInto?: TicketId;
}

export interface CreateTicketInput {
  readonly tenantId: TenantId;
  readonly subject: string;
  readonly description: string;
  readonly requesterId: CustomerId;
  readonly channel: TicketChannel;
  readonly priority?: TicketPriority;
  readonly tags?: readonly string[];
  readonly language?: string;
  readonly productId?: string;
  readonly customFields?: Readonly<Record<string, string | number | boolean>>;
  readonly idempotencyKey?: string;
}

export const OPEN_STATUSES: readonly TicketStatus[] = [
  'new',
  'triaged',
  'in_progress',
  'pending_customer',
  'pending_third_party',
  'resolved',
];

export function isOpenStatus(status: TicketStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export const PRIORITY_ORDER: Readonly<Record<TicketPriority, number>> = {
  low: 1,
  normal: 2,
  high: 3,
  urgent: 4,
};

export function comparePriority(a: TicketPriority, b: TicketPriority): number {
  return PRIORITY_ORDER[a] - PRIORITY_ORDER[b];
}
