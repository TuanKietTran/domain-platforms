# @platform/helpdesk

A multi-tenant customer support platform core in strict TypeScript: ticket lifecycle with a guarded state machine, business-hours SLA engine, deterministic explainable routing, a versioned knowledge base with cited retrieval, an immutable audit trail, and a reusable AI agent harness with permissions, budgets, and human approval gates. Around that deep core sit parallel modules — channel intake adapters, notifications, automation rules and macros, analytics, CRM/product integrations, and QA scoring — each behind a typed interface with a working implementation and tests.

No runtime dependencies; tests run fully offline.

## Run

Requires Node >= 20.

```sh
npm ci
npm test           # build + full test suite (118 tests)
npm run typecheck  # tsc --noEmit
npm run build      # emit to dist/ (gitignored)
```

## Layout

```
src/
  core/          ids (branded), errors (DomainError), clock, util, audit, tenancy, idempotency, events
  tickets/       types, state-machine, repository, service
  sla/           SLA calendars, targets, deadlines, breach evaluation
  routing/       deterministic, explainable routing and assignment
  knowledge/     versioned article store + BM25-style cited retrieval
  harness/       agent harness core (permissions, budgets, approval gates), FakeModel, built-in agents
  channels/      email/chat/web/API/phone intake adapters
  notifications/ template engine with sender ports, opt-outs, dedupe
  automation/    workflow rules + macros (pure decisions)
  analytics/     volume, resolution/CSAT/SLA aggregations, daily trends
  integrations/  CRM + product adapter ports, in-memory adapters, registry
  qa/            weighted scorecards and per-agent summaries
tests/           one suite per module (node:test, FakeClock/SequentialIdGenerator fixtures)
docs/DOMAIN-MAP.md   domains -> modules, deep vs parallel, cross-cutting concerns, success-criteria checks
```

## Plug things in

### A channel

Implement `ChannelAdapter` and register it; `toCreateTicketInput` turns normalised intake into a ticket creation:

```ts
import { ChannelRegistry, toCreateTicketInput, type ChannelAdapter } from './src/channels/adapters.js';

const smsAdapter: ChannelAdapter<RawSms> = {
  channel: 'chat', // use the TicketChannel closest to the source
  adapt: (raw, tenantId) => ({ tenantId, channel: 'chat', subject: raw.text.slice(0, 80), description: raw.text, requester: { externalId: raw.from }, externalId: raw.id, receivedAt: raw.at, tags: ['sms'] }),
};
const registry = new ChannelRegistry();
registry.register(smsAdapter as ChannelAdapter<never>);
const input = toCreateTicketInput(registry.adapt('chat', rawSms, tenantId), requesterId);
```

### A rule

Routing rules are passed to the routing engine constructor (bare array or options). Automation rules register on the engine and are evaluated as pure decisions — the caller applies the result:

```ts
import { AutomationEngine } from './src/automation/engine.js';

const automation = new AutomationEngine();
automation.registerRule({ id: 'vip-fastlane', priority: 1, trigger: 'ticket_created', conditions: { tagsAll: ['vip'] }, actions: { setPriority: 'urgent', addTags: ['fastlane'] } });
const decision = automation.evaluate('ticket_created', snapshot); // decision.priority, decision.tags, decision.explanation
```

### An adapter or sender

Notifications deliver through a `NotificationSender` port per channel; CRM and product systems sit behind adapter ports in a registry; QA adds scorecards the same way:

```ts
import { IntegrationRegistry, InMemoryCrmAdapter } from './src/integrations/adapters.js';

const integrations = new IntegrationRegistry();
integrations.registerCrm(new InMemoryCrmAdapter()); // replace with a real CRM adapter implementing CrmAdapter
const crm = integrations.getCrm('memory-crm');
```

For AI work, implement the harness `Model` port (or use the deterministic `FakeModel` in tests) and declare each agent's permissions and budget in `src/harness/types.ts` style; actions that resolve, close, or escalate stay gated behind human approval by construction.

## Design rules

- Branded ids and `TenantId` on everything; cross-tenant access is `NOT_FOUND`/`TENANT_MISMATCH`, never a leak.
- Domain failures are `DomainError` with stable codes — no bare throws across module boundaries.
- Published objects are immutable (`deepFreeze`); state changes produce new values.
- Time, ids, and model output are injectable (`Clock`, `IdGenerator`, `Model`) so behaviour is deterministic and testable offline.
