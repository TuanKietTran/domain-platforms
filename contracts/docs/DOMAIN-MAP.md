# Contract Platform — Domain Map

Production-grade legal/contract management platform. Node 20+, strict TypeScript, zero external
services (in-memory storage with optional SQLite persistence), fully offline tests with a
deterministic fake model. This map assigns every PRD domain and use case to a module, marks the
DEEP items (built first, highest quality) and the PARALLEL items (typed, working modules behind
clean interfaces), locates cross-cutting concerns, and states how success criteria are verified.
No step-by-step implementation plans.

## Module map

| Module (src/) | PRD domain / use cases it covers | Depth |
| --- | --- | --- |
| `core/ids`, `core/events` | Event-driven architecture; idempotent mutations; typed identity for every aggregate | DEEP |
| `core/errors` | Typed domain errors shared by all modules | DEEP |
| `identity/` | Multi-tenant identity, users, roles, permissions, scoping of every operation | DEEP |
| `lifecycle/` | **1. Contract Lifecycle**: request/intake, drafting, negotiation, review, approval, execution, amendments, renewals, expiration, termination — as a guard-railed state machine with versioned contract records | DEEP |
| `versioning/` | **2. Versioning & Provenance**: draft series, executed-contract immutability, amendment chains, provenance of every change (actor, method, reason) | DEEP |
| `documents/` | **2b. Document & Metadata Model**: documents, metadata, related-document links, retention/legal-hold ready storage | DEEP (model) |
| `clauses/` | **2c. Clause & Template Management**: template library, clause library, playbooks, fallback positions, template versioning | PARALLEL (behind `<sup>growth-kit` interface) |
| `obligations/` | **3. Obligation & Milestone Tracking**: obligations, key dates, reminder/escalation scheduling, performance status; deterministic clock | DEEP |
| `risk/` | **4. Risk & Compliance**: risk scoring, policy checks, approval matrices by risk level | DEEP (rules core) |
| `collab/` | **5. Collaboration & Negotiation**: internal/external review workflows, redlines, comments, version comparison | PARALLEL |
| `repository/` | **6. Repository & Search**: repository over `documents/` + `contracts/`, metadata extraction hooks, search index, related linking | PARALLEL |
| `audit/` | **7. Audit & Regulatory**: append-only, hash-chained event log of edits, approvals, access, AI suggestions; retention + legal hold | DEEP |
| `analytics/` | **8. Analytics**: cycle time, bottlenecks, risk distribution, obligation compliance rate, renewal pipeline — computed from the event log and lifecycle records | PARALLEL |
| `harness/` | **AI/LLM agent harness**: `AgentRuntime` with permission checks, token/step budgets, evaluation traces, approval gates, human-in-the-loop escalation, deterministic fake model | DEEP |
| `harness/agents` | Extraction, risk/deviation summarization, drafting suggestions, redline summaries, corpus Q&A agents — each a registered, budgeted, gated agent | PARALLEL |
| `integrations/` | E-signature, CRM, storage adapters + notification engine — typed ports, no network in tests | PARALLEL |
| `api/` | Typed façade composing the above into use-case-level service functions (intake UI, authoring tools, dashboards call this) | glue |

## Where each domain's DEEP quality lives

- **Lifecycle state machine** — `lifecycle/state-machine.ts`: declarative transition table, guard
  functions (risk-gated approvals, required signer roles, tenancy checks), version bump on every
  transition, idempotent command deduplication.
- **Versioning & provenance** — `versioning/`: append-only `VersionedRecord` history; executed
  contracts are immutable and changeable only through amendments; every version records actor,
  acting-as tenant, method (human/AI/manual), reason and parent version.
- **Obligation & date engine** — `obligations/`: pure date arithmetic over a deterministic clock;
  reminders/escalations derived from obligation terms; statuses tracked against value thresholds.
- **Audit & decision trace** — `audit/`: append-only store; every record hash-chained to its
  predecessor; legal hold forbids purging independently of retention.
- **Identity, permissions & multi-tenancy** — `identity/`: tenant-scoped principals, role →
  permission mapping, `requirePermission()` used by every mutating service.
- **Document & metadata model** — `documents/`: typed `ContractDocument` with metadata schema,
  related-document links, retention policy and hold flag on the record itself.
- **Agent harness core** — `harness/`: runtime composes fake model + tools + policies; budgets
  enforced before each step; traces recorded to `audit/` for every suggestion; approval gate can
  never be bypassed silently for high-risk actions.

## Parallel modules behind clean interfaces

Each parallel module implements a typed port (interface) declared next to DEEP core types and is
consumed only through those ports, so parallel teams can build concurrently:

- `clauses/` implements `TemplatePort` used by `lifecycle/` when materializing a contract from a
  template (fallback clauses resolved at draft time).
- `collab/` implements `ReviewPort` consumed by the lifecycle's negotiation phase.
- `repository/` implements `SearchPort` consumed by Q&A/RAG and UI listing.
- `harness/agents/` implements `ContractAgent` consumed by `harness/AgentRuntime`.
- `analytics/` reads only the audit event log + lifecycle store (read-only projections).
- `integrations/` implement typed adapter ports (`EsignaturePort`, `CrmPort`, `StoragePort`,
  `NotifierPort`) with offline fakes for tests.

## Cross-cutting concerns and where they live

- Event-driven core → `core/events.ts` (`DomainEventBus`, typed events, idempotent `eventId`).
- Immutability of executed contracts → `versioning/` enforced inside `lifecycle/` service.
- Observability of AI suggestions → every agent step emits an `AgentTrace` event to `audit/`.
- Strong domain typing → `types/` re-exported by every module; strict `tsconfig`; no `any`.
- Evaluation harness for AI → `harness/evals.ts` runs agents against fixtures offline.
- Retention & legal hold → flags on `documents/` records; purge logic in `audit/` respects a hold.

## Success criteria → verification

| Success criterion | Verified by |
| --- | --- |
| Contracts move request → execution with full history | `lifecycle.test.ts` — full happy path + guard rejections; history assertions on version/provenance |
| Obligations and key dates accurately tracked | `obligations.test.ts` — deterministic clock, reminder/escalation firing |
| Risk and deviation decisions explainable | `risk.test.ts` + `harness/evals` — every decision carries rule id + trace |
| AI assists but never silently approves high-risk changes | `harness.test.ts` — high-risk suggestion requires approval-gate acceptance recorded in the audit log |
| New templates/playbooks with minimal core changes | `clauses` added as data + `TemplatePort`; core imports only the port |
| Full negotiation/approval history reconstructable | `audit.test.ts` — hash chain validation + projection replay reconstructs the timeline |

## Test layout (all offline, `npm test`)

`tests/` mirrors `src/`: `core`, `identity`, `lifecycle`, `versioning`, `documents`, `obligations`,
`risk`, `audit`, `harness` (DEEP), plus `clauses`, `collab`,
`repository`, `analytics`, `integrations`, `agents` (PARALLEL). One shared fake model fixture; a tiny built-in test runner; `npm test` runs the
whole suite from a clean checkout after `npm install`.
