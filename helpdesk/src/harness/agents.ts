import { round, unique } from '../core/util.js';
import type { TicketPriority } from '../tickets/types.js';
import type { AgentHarness } from './harness.js';
import type { AgentDefinition, AgentRun } from './types.js';

export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
  { id: 'classifier', name: 'Classification + priority', permissions: ['ticket:classify'], budget: { maxTokensPerRun: 2000, maxCostPerRun: 1 }, costPerThousandTokens: 0.1 },
  { id: 'drafter', name: 'Draft reply', permissions: ['ticket:draft_reply'], budget: { maxTokensPerRun: 4000, maxCostPerRun: 2 }, costPerThousandTokens: 0.2 },
  { id: 'summarizer', name: 'Thread summary', permissions: ['ticket:summarize'], budget: { maxTokensPerRun: 8000, maxCostPerRun: 4 }, costPerThousandTokens: 0.2 },
  { id: 'sentiment', name: 'Sentiment + urgency', permissions: ['ticket:analyze'], budget: { maxTokensPerRun: 2000, maxCostPerRun: 1 }, costPerThousandTokens: 0.1 },
  { id: 'auto-resolver', name: 'Auto-resolve (low-risk, human-in-the-loop)', permissions: ['ticket:resolve', 'ticket:close', 'ticket:escalate'], budget: { maxTokensPerRun: 2000, maxCostPerRun: 1 }, costPerThousandTokens: 0.1 },
];

export function registerBuiltInAgents(harness: AgentHarness): void {
  for (const agent of BUILT_IN_AGENTS) harness.registerAgent(agent);
}

export interface TicketAgentInput {
  readonly ticketId: string;
  readonly subject: string;
  readonly description: string;
}

function textOf(input: TicketAgentInput): string {
  return `${input.subject} ${input.description}`.toLowerCase();
}

function matched(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword));
}

const CATEGORIES: readonly (readonly [string, readonly string[]])[] = [
  ['billing', ['invoice', 'billing', 'payment', 'charge', 'refund', 'subscription']],
  ['account', ['password', 'login', 'sign in', 'account', 'reset', 'locked out']],
  ['technical', ['error', 'bug', 'crash', 'not working', 'broken', 'app']],
  ['shipping', ['delivery', 'shipping', 'package', 'tracking', 'order arrived']],
];

const URGENT_SIGNALS = ['urgent', 'outage', 'breach', 'security', 'locked out', 'cannot access', 'down'];

export interface Classification { readonly category: string; readonly priority: TicketPriority; readonly confidence: number; readonly reasons: readonly string[]; }

export function classifyTicket(harness: AgentHarness, tenantId: AgentRun['tenantId'], input: TicketAgentInput): AgentRun {
  return harness.run<Classification>({ tenantId, agentId: 'classifier', task: 'classification', permission: 'ticket:classify', execute: () => {
    const text = textOf(input);
    let category = 'general';
    let best: string[] = [];
    for (const [name, keywords] of CATEGORIES) { const hits = matched(text, keywords); if (hits.length > best.length) { category = name; best = hits; } }
    const urgent = matched(text, URGENT_SIGNALS);
    const priority: TicketPriority = urgent.length >= 2 || urgent.includes('outage') || urgent.includes('breach') ? 'urgent' : urgent.length === 1 ? 'high' : text.includes('how to') || text.includes('question') ? 'low' : 'normal';
    const output: Classification = { category, priority, confidence: best.length === 0 ? 0.4 : round(Math.min(0.95, 0.5 + 0.1 * best.length + (urgent.length > 0 ? 0.1 : 0)), 2), reasons: [...best.map((k) => `keyword:${k}`), ...urgent.map((k) => `urgency:${k}`)] };
    return { output, proposedAction: { kind: 'classify', ticketId: input.ticketId, summary: `${category}/${priority}` } };
  } });
}

export interface DraftReply { readonly draft: string; readonly citations: readonly { articleId: string; version: number }[]; }

export function draftReply(harness: AgentHarness, tenantId: AgentRun['tenantId'], input: TicketAgentInput & { readonly customerName?: string; readonly citations?: readonly { articleId: string; version: number }[] }): AgentRun {
  return harness.run<DraftReply>({ tenantId, agentId: 'drafter', task: 'draft_reply', permission: 'ticket:draft_reply', execute: (model) => {
    const response = model.generate({ task: 'draft_reply', prompt: `${input.subject}. ${input.description}`, context: { subject: input.subject, customerName: input.customerName ?? 'there' } });
    return { output: { draft: response.text, citations: input.citations ?? [] }, proposedAction: { kind: 'suggest_reply', ticketId: input.ticketId, summary: 'Draft reply suggested; nothing sent' } };
  } });
}

export interface ThreadMessage { readonly authorKind: string; readonly body: string; }
export interface ThreadSummary { readonly summary: string; readonly keyPoints: readonly string[]; readonly messageCount: number; readonly participants: readonly string[]; }

function firstSentence(body: string): string { const t = body.trim(); const end = t.search(/[.!?]/); return end === -1 ? t : t.slice(0, end + 1); }

export function summarizeThread(harness: AgentHarness, tenantId: AgentRun['tenantId'], ticketId: string, messages: readonly ThreadMessage[]): AgentRun {
  return harness.run<ThreadSummary>({ tenantId, agentId: 'summarizer', task: 'summarize_thread', permission: 'ticket:summarize', execute: () => {
    const keyPoints = messages.slice(0, 5).map((message) => firstSentence(message.body));
    const output: ThreadSummary = { summary: keyPoints.join(' '), keyPoints, messageCount: messages.length, participants: unique(messages.map((m) => m.authorKind)) };
    return { output, proposedAction: { kind: 'summarize', ticketId, summary: 'Thread summarized' } };
  } });
}

const NEGATIVE = ['angry', 'frustrated', 'terrible', 'awful', 'unacceptable', 'disappointed', 'furious', 'worst'];
const POSITIVE = ['thanks', 'thank you', 'great', 'happy', 'excellent', 'love'];
const URGENCY = ['urgent', 'asap', 'immediately', 'outage', 'deadline'];

export interface SentimentResult { readonly sentiment: 'positive' | 'neutral' | 'negative'; readonly score: number; readonly urgency: 'low' | 'normal' | 'high'; readonly signals: readonly string[]; }

export function analyzeSentiment(harness: AgentHarness, tenantId: AgentRun['tenantId'], input: TicketAgentInput): AgentRun {
  return harness.run<SentimentResult>({ tenantId, agentId: 'sentiment', task: 'sentiment_urgency', permission: 'ticket:analyze', execute: () => {
    const text = textOf(input);
    const negative = matched(text, NEGATIVE); const positive = matched(text, POSITIVE); const urgencyHits = matched(text, URGENCY);
    const score = positive.length - negative.length;
    const output: SentimentResult = { sentiment: score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral', score, urgency: urgencyHits.length > 0 ? 'high' : 'normal', signals: [...negative.map((k) => `negative:${k}`), ...positive.map((k) => `positive:${k}`), ...urgencyHits.map((k) => `urgency:${k}`)] };
    return { output, proposedAction: { kind: 'analyze_sentiment', ticketId: input.ticketId, summary: `${output.sentiment}/${output.urgency}` } };
  } });
}

const KNOWN_SOLUTIONS = ['reset password', 'password reset', 'download invoice', 'invoice copy', 'business hours', 'opening hours'];
const RISK_SIGNALS = ['angry', 'frustrated', 'refund', 'chargeback', 'legal', 'security', 'breach', 'urgent', 'outage', 'payment failed', 'terrible', 'furious'];

export interface AutoResolveAssessment { readonly recommendation: 'resolve' | 'manual_review'; readonly risk: 'low' | 'high'; readonly reasons: readonly string[]; }

export function autoResolve(harness: AgentHarness, tenantId: AgentRun['tenantId'], input: TicketAgentInput): AgentRun {
  return harness.run<AutoResolveAssessment>({ tenantId, agentId: 'auto-resolver', task: 'auto_resolve', permission: 'ticket:resolve', execute: () => {
    const text = textOf(input);
    const known = matched(text, KNOWN_SOLUTIONS); const risks = matched(text, RISK_SIGNALS);
    const low = known.length > 0 && risks.length === 0;
    const output: AutoResolveAssessment = { recommendation: low ? 'resolve' : 'manual_review', risk: low ? 'low' : 'high', reasons: low ? known.map((k) => `known_solution:${k}`) : [...(known.length === 0 ? ['no_known_solution'] : []), ...risks.map((k) => `risk:${k}`)] };
    return low ? { output, proposedAction: { kind: 'resolve_ticket', ticketId: input.ticketId, summary: `Low-risk auto-resolve: ${known.join(', ')}` } } : { output };
  } });
}
