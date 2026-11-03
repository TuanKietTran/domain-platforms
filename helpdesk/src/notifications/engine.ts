import { SystemClock, type Clock } from '../core/clock.js';
import { DomainError } from '../core/errors.js';
import type { IdGenerator, NotificationId, TenantId } from '../core/ids.js';
import { deepFreeze } from '../core/util.js';

export type NotificationChannel = 'email' | 'sms' | 'push' | 'in_app';

export interface NotificationTemplate {
  readonly id: string;
  readonly category: string;
  readonly subject?: string;
  readonly body: string;
}

export interface OutboundMessage {
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  readonly subject?: string;
  readonly body: string;
}

export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(message: OutboundMessage): void;
}

export class InMemorySender implements NotificationSender {
  readonly sent: OutboundMessage[] = [];
  constructor(readonly channel: NotificationChannel) {}
  send(message: OutboundMessage): void { this.sent.push(message); }
}

export type NotificationStatus = 'sent' | 'suppressed';

export interface NotificationRecord {
  readonly id: NotificationId;
  readonly tenantId: TenantId;
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  readonly templateId: string;
  readonly category: string;
  readonly subject?: string;
  readonly body: string;
  readonly status: NotificationStatus;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface SendNotificationInput {
  readonly tenantId: TenantId;
  readonly recipientId: string;
  readonly templateId: string;
  readonly channel: NotificationChannel;
  readonly variables?: Readonly<Record<string, string>>;
  readonly dedupeKey?: string;
}

function render(template: string, variables: Readonly<Record<string, string>>, templateId: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) throw new DomainError('VALIDATION', 'Missing template variable', { templateId, variable: key });
    return value;
  });
}

/** Template-based notification engine with per-recipient channel opt-outs and dedupe keys, behind a sender port per channel. */
export class NotificationEngine {
  private readonly templates = new Map<string, NotificationTemplate>();
  private readonly senders = new Map<NotificationChannel, NotificationSender>();
  private readonly optOuts = new Set<string>();
  private readonly records: NotificationRecord[] = [];
  private readonly dedupe = new Map<string, NotificationRecord>();

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  registerTemplate(template: NotificationTemplate): void {
    if (template.id.trim().length < 2 || template.body.trim().length === 0) throw new DomainError('VALIDATION', 'Template requires an id and a body');
    if (this.templates.has(template.id)) throw new DomainError('CONFLICT', 'Template already registered', { templateId: template.id });
    this.templates.set(template.id, deepFreeze({ ...template }));
  }

  registerSender(sender: NotificationSender): void {
    if (this.senders.has(sender.channel)) throw new DomainError('CONFLICT', 'Sender already registered for channel', { channel: sender.channel });
    this.senders.set(sender.channel, sender);
  }

  setChannelOptOut(tenantId: TenantId, recipientId: string, channel: NotificationChannel, optedOut = true): void {
    const key = `${tenantId}|${recipientId}|${channel}`;
    if (optedOut) this.optOuts.add(key); else this.optOuts.delete(key);
  }

  send(input: SendNotificationInput): NotificationRecord {
    if (input.dedupeKey) {
      const existing = this.dedupe.get(`${input.tenantId}|${input.recipientId}|${input.dedupeKey}`);
      if (existing) return existing;
    }
    const template = this.templates.get(input.templateId);
    if (!template) throw new DomainError('NOT_FOUND', 'Notification template not found', { templateId: input.templateId });
    const variables = input.variables ?? {};
    const body = render(template.body, variables, template.id);
    const subject = template.subject ? render(template.subject, variables, template.id) : undefined;
    const optedOut = this.optOuts.has(`${input.tenantId}|${input.recipientId}|${input.channel}`);
    let record: NotificationRecord;
    if (optedOut) {
      record = deepFreeze({ id: this.ids.next('ntf') as NotificationId, tenantId: input.tenantId, recipientId: input.recipientId, channel: input.channel, templateId: template.id, category: template.category, subject, body, status: 'suppressed' as const, reason: 'opt_out', createdAt: this.clock.now().toISOString() });
    } else {
      const sender = this.senders.get(input.channel);
      if (!sender) throw new DomainError('NOT_FOUND', 'No sender registered for channel', { channel: input.channel });
      sender.send({ recipientId: input.recipientId, channel: input.channel, subject, body });
      record = deepFreeze({ id: this.ids.next('ntf') as NotificationId, tenantId: input.tenantId, recipientId: input.recipientId, channel: input.channel, templateId: template.id, category: template.category, subject, body, status: 'sent' as const, createdAt: this.clock.now().toISOString() });
    }
    this.records.push(record);
    if (input.dedupeKey) this.dedupe.set(`${input.tenantId}|${input.recipientId}|${input.dedupeKey}`, record);
    return record;
  }

  list(tenantId: TenantId, recipientId?: string): readonly NotificationRecord[] {
    return this.records.filter((r) => r.tenantId === tenantId && (recipientId === undefined || r.recipientId === recipientId));
  }
}
