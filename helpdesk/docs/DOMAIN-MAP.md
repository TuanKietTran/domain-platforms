# Domain Map — @platform/helpdesk

How the support-platform domains map onto modules, which modules are deep (foundational, built first, highest quality bar), which are parallel (typed interface + one working implementation, extensible without core changes), and how the cross-cutting concerns and the PRD success criteria are checked.

## Domains → modules

| Domain | Modules | Owns |
|---|---|---|
| Ticket lifecycle | `src/tickets/types.ts`, `state-machine.ts`, `repository.ts`, `service.ts` | Ticket shape and statuses, legal transitions, storage, orchestration of create/transition flows |
| SLA | `src/sla/engine.ts` | Business calendars, targets per priority, deadlines, pause/resume, breach evaluation |
| Routing & assignment | `src/routing/engine.ts` | Deterministic, explainable rule matching, candidate/agent-pool selection, load and capacity |
| Identity & multi-tenancy | `src/core/tenancy.ts`, `src/core/ids.ts` | Tenants, users, roles/permissions, principals; branded id types used everywhere |
| Audit & trace | `src/core/audit.ts` | Immutable audit entries for mutations and AI evaluation traces |
| Idempotency & events | `src/core/idempotency.ts`, `src/core/events.ts` | Idempotent mutations, shared domain-event types |
| Platform primitives | `src/core/errors.ts`, `clock.ts`, `util.ts` | `DomainError` codes, `Clock` (`SystemClock`/`FakeClock`), `deepFreeze`/canonical JSON helpers |
| Knowledge & retrieval | `src/knowledge/types.ts`, `store.ts`, `retrieval.ts` | Versioned articles, publish/archive lifecycle, BM25-style cited search over published articles |
| Agent harness | `src/harness/types.ts`, `model.ts`, `harness.ts`, `agents.ts` | Per-agent permissions, token/cost budgets, approval gates, `Model`/`ActionExecutor` ports, `FakeModel`, the five built-in agents |
| Channel intake | `src/channels/adapters.ts` | Email/chat/web/API/phone adapters normalising raw payloads into ticket intake |
| Notifications | `src/notifications/engine.ts` | Templates, per-channel sender ports, opt-outs, dedupe |
| Automation | `src/automation/engine.ts` | Ordered tenant-scoped workflow rules, facet conditions, macros |
| Analytics | `src/analytics/engine.ts` | Tenant/range-filtered aggregations and daily trends over ticket facts |
| Integrations | `src/integrations/adapters.ts` | CRM and product ports, in-memory adapters, adapter registry, ticket-context enrichment |
| QA | `src/qa/engine.ts` | Weighted scorecards, evaluations, per-agent quality summaries |

## Deep vs parallel

**Deep (foundational).** Ticket state machine & SLA engine, routing, audit, identity/permissions/multi-tenancy, knowledge & retrieval model, and the agent harness core. These define the invariants every other module relies on: legal transitions only, explainable routing/SLA decisions, tenant scoping on every read, an audit entry for every consequential action, and AI actions that can never bypass approval gates. They carry the densest tests (state-machine, SLA, routing, tenancy, audit, idempotency, knowledge, harness suites).

**Parallel.** Channel adapters, notification engine, automation, analytics, integrations, and QA. Each is a typed interface plus one working implementation plus its own test file, and each plugs into the core through a registry or a pure decision function (`ChannelRegistry`, `NotificationEngine` sender ports, `AutomationEngine.evaluate`, `IntegrationRegistry`, `QaEngine`). Adding a channel, rule set, CRM, or scorecard touches no core module.

## Cross-cutting concerns

- **Multi-tenancy everywhere:** every domain object carries a branded `TenantId`; cross-tenant reads resolve as `NOT_FOUND` or fail with `TENANT_MISMATCH`, never leak.
- **Strong typing:** branded ids (`TicketId`, `UserId`, `CrmRecordId`, …), readonly interfaces, strict TypeScript; validation failures are `DomainError` with a stable code (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `POLICY_DENIED`, `BUDGET_EXHAUSTED`, `APPROVAL_REQUIRED`, …).
- **Immutability:** published domain objects are `deepFreeze`d; transitions and upserts produce new values instead of mutating.
- **Determinism:** `FakeClock`, `SequentialIdGenerator`, and `FakeModel` make time, ids, and model output reproducible; rankings and rule ordering always have an explicit tie-break.
- **Idempotency:** ticket mutations accept idempotency keys (`src/core/idempotency.ts`); notification sends accept dedupe keys; channel intake derives its key from channel + external id.
- **Auditability & observability:** mutations and harness runs write audit entries; routing, automation, and SLA decisions return human-readable explanations alongside the decision.
- **Approval gates for AI:** harness actions that resolve, close, or escalate end in `pending_approval`; the executor runs only from `approve()`, exactly once.

## Success-criteria checks

| PRD criterion | How it is checked |
|---|---|
| Tickets move reliably from intake to resolution with full history | State-machine suite: every legal/illegal transition, version bumps, transition records; channel adapters convert intake via `toCreateTicketInput`; audit suite covers the trace |
| Routing and SLA decisions are consistent and explainable | Routing suite: facet matching, ordering/first-wins, capacity and fallback, decision explanations; SLA suite: business-time math, pause/resume, breach states |
| AI accelerates agents but does not silently close or escalate | Harness suite: gated resolve/close/escalate never touch the executor before approval, execute exactly once on approve, never on reject; budget and permission denials are typed errors |
| Knowledge retrieval is accurate and cited | Knowledge suite: published-only, tenant-scoped search; ranking weights; every hit carries a citation to the current article version |
| New channels or automation rules can be added with minimal core changes | Registry/ports design above; channels, notifications, automation, integrations, and QA suites each exercise registration, duplicate rejection, and unknown-name lookup |
| Operators can always reconstruct what happened on a ticket | Audit log plus per-ticket transition records; routing/automation/harness decisions all return explanations or traces |
