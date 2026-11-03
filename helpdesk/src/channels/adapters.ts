import { DomainError } from '../core/errors.js';
import { SystemClock, type Clock } from '../core/clock.js';
import type { CustomerId, TenantId } from '../core/ids.js';
import type { CreateTicketInput, TicketChannel, TicketPriority } from '../tickets/types.js';

export interface IntakeRequester {
  readonly externalId: string;
  readonly email?: string;
  readonly name?: string;
  readonly phone?: string;
}

export interface NormalizedIntake {
  readonly tenantId: TenantId;
  readonly channel: TicketChannel;
  readonly subject: string;
  readonly description: string;
  readonly requester: IntakeRequester;
  readonly externalId: string;
  readonly receivedAt: string;
  readonly tags: readonly string[];
  readonly language?: string;
  readonly priority?: TicketPriority;
}

export interface ChannelAdapter<TRaw = unknown> {
  readonly channel: TicketChannel;
  adapt(raw: TRaw, tenantId: TenantId): NormalizedIntake;
}

function fail(message: string): never { throw new DomainError('VALIDATION', message); }
function record(raw: unknown): Record<string, unknown> { if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('Channel payload must be an object'); return raw as Record<string, unknown>; }
function reqString(value: unknown, field: string): string { if (typeof value !== 'string' || value.trim().length === 0) fail(`Missing required field: ${field}`); return (value as string).trim(); }
function optString(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined; }
function reqEmail(value: unknown, field: string): string { const email = reqString(value, field); if (!email.includes('@')) fail(`Invalid email in field: ${field}`); return email.toLowerCase(); }
function stripHtml(html: string): string { return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function truncate(text: string, max: number): string { return text.length > max ? text.slice(0, max - 3).trimEnd() + '...' : text; }

const PRIORITIES: readonly string[] = ['low', 'normal', 'high', 'urgent'];

export interface RawEmail { readonly messageId: string; readonly from: { readonly email: string; readonly name?: string }; readonly subject?: string; readonly text?: string; readonly html?: string; readonly date?: string; }
export class EmailAdapter implements ChannelAdapter<RawEmail> {
  readonly channel = 'email' as const;
  constructor(private readonly clock: Clock = new SystemClock()) {}
  adapt(raw: RawEmail, tenantId: TenantId): NormalizedIntake {
    const data = record(raw); const from = record(data.from);
    const body = optString(data.text) ?? (optString(data.html) ? stripHtml(data.html as string) : undefined);
    if (!body) fail('Email body is required');
    return { tenantId, channel: 'email', subject: optString(data.subject) ?? '(no subject)', description: body, requester: { externalId: reqEmail(from.email, 'from.email'), email: reqEmail(from.email, 'from.email'), name: optString(from.name) }, externalId: reqString(data.messageId, 'messageId'), receivedAt: optString(data.date) ?? this.clock.now().toISOString(), tags: ['email'] };
  }
}

export interface RawChat { readonly sessionId: string; readonly userId: string; readonly name?: string; readonly email?: string; readonly messages: readonly { readonly text: string }[]; readonly startedAt?: string; }
export class ChatAdapter implements ChannelAdapter<RawChat> {
  readonly channel = 'chat' as const;
  constructor(private readonly clock: Clock = new SystemClock()) {}
  adapt(raw: RawChat, tenantId: TenantId): NormalizedIntake {
    const data = record(raw);
    if (!Array.isArray(data.messages) || data.messages.length === 0) fail('Chat payload requires at least one message');
    const texts = (data.messages as { text: unknown }[]).map((m, i) => reqString(m?.text, `messages[${i}].text`));
    return { tenantId, channel: 'chat', subject: truncate(texts[0] as string, 80), description: texts.join('\n'), requester: { externalId: reqString(data.userId, 'userId'), email: optString(data.email), name: optString(data.name) }, externalId: reqString(data.sessionId, 'sessionId'), receivedAt: optString(data.startedAt) ?? this.clock.now().toISOString(), tags: ['chat'] };
  }
}

export interface RawWebForm { readonly submissionId: string; readonly email: string; readonly name?: string; readonly subject?: string; readonly category?: string; readonly message: string; readonly language?: string; }
export class WebAdapter implements ChannelAdapter<RawWebForm> {
  readonly channel = 'web' as const;
  constructor(private readonly clock: Clock = new SystemClock()) {}
  adapt(raw: RawWebForm, tenantId: TenantId): NormalizedIntake {
    const data = record(raw);
    const category = optString(data.category);
    return { tenantId, channel: 'web', subject: optString(data.subject) ?? (category ? `${category} request` : 'Web form submission'), description: reqString(data.message, 'message'), requester: { externalId: reqEmail(data.email, 'email'), email: reqEmail(data.email, 'email'), name: optString(data.name) }, externalId: reqString(data.submissionId, 'submissionId'), receivedAt: this.clock.now().toISOString(), tags: category ? ['web', category.toLowerCase()] : ['web'], language: optString(data.language) };
  }
}

export interface RawApiTicket { readonly externalId: string; readonly customerId: string; readonly title: string; readonly body: string; readonly priority?: string; readonly tags?: readonly string[]; readonly language?: string; readonly createdAt?: string; }
export class ApiAdapter implements ChannelAdapter<RawApiTicket> {
  readonly channel = 'api' as const;
  constructor(private readonly clock: Clock = new SystemClock()) {}
  adapt(raw: RawApiTicket, tenantId: TenantId): NormalizedIntake {
    const data = record(raw);
    const priority = optString(data.priority);
    if (priority !== undefined && !PRIORITIES.includes(priority)) fail(`Invalid priority: ${priority}`);
    return { tenantId, channel: 'api', subject: reqString(data.title, 'title'), description: reqString(data.body, 'body'), requester: { externalId: reqString(data.customerId, 'customerId') }, externalId: reqString(data.externalId, 'externalId'), receivedAt: optString(data.createdAt) ?? this.clock.now().toISOString(), tags: Array.isArray(data.tags) ? (data.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [], language: optString(data.language), priority: priority as TicketPriority | undefined };
  }
}

export interface RawPhoneCall { readonly callId: string; readonly phone: string; readonly callerName?: string; readonly transcript: string; readonly startedAt?: string; readonly language?: string; }
export class PhoneAdapter implements ChannelAdapter<RawPhoneCall> {
  readonly channel = 'phone' as const;
  constructor(private readonly clock: Clock = new SystemClock()) {}
  adapt(raw: RawPhoneCall, tenantId: TenantId): NormalizedIntake {
    const data = record(raw);
    const phone = reqString(data.phone, 'phone'); const name = optString(data.callerName);
    return { tenantId, channel: 'phone', subject: name ? `Phone call from ${name} (${phone})` : `Phone call from ${phone}`, description: reqString(data.transcript, 'transcript'), requester: { externalId: phone, phone, name }, externalId: reqString(data.callId, 'callId'), receivedAt: optString(data.startedAt) ?? this.clock.now().toISOString(), tags: ['phone'], language: optString(data.language) };
  }
}

export class ChannelRegistry {
  private readonly adapters = new Map<TicketChannel, ChannelAdapter<never>>();
  register(adapter: ChannelAdapter<never>): void {
    if (this.adapters.has(adapter.channel)) throw new DomainError('CONFLICT', 'Channel adapter already registered', { channel: adapter.channel });
    this.adapters.set(adapter.channel, adapter);
  }
  get(channel: TicketChannel): ChannelAdapter<never> {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new DomainError('NOT_FOUND', 'No adapter for channel', { channel });
    return adapter;
  }
  adapt(channel: TicketChannel, raw: unknown, tenantId: TenantId): NormalizedIntake { return this.get(channel).adapt(raw as never, tenantId); }
  channels(): readonly TicketChannel[] { return [...this.adapters.keys()]; }
}

export function createDefaultChannelRegistry(clock: Clock = new SystemClock()): ChannelRegistry {
  const registry = new ChannelRegistry();
  registry.register(new EmailAdapter(clock) as ChannelAdapter<never>);
  registry.register(new ChatAdapter(clock) as ChannelAdapter<never>);
  registry.register(new WebAdapter(clock) as ChannelAdapter<never>);
  registry.register(new ApiAdapter(clock) as ChannelAdapter<never>);
  registry.register(new PhoneAdapter(clock) as ChannelAdapter<never>);
  return registry;
}

export function toCreateTicketInput(intake: NormalizedIntake, requesterId: CustomerId): CreateTicketInput {
  return { tenantId: intake.tenantId, subject: intake.subject, description: intake.description, requesterId, channel: intake.channel, priority: intake.priority, tags: intake.tags, language: intake.language, idempotencyKey: `${intake.channel}:${intake.externalId}` };
}
