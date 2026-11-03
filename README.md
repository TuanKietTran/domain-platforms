# Domain platforms

Three production-minded business platforms, each a strictly typed TypeScript library with an event-driven core, an immutable audit trail, multi-tenant identity and permissions, and a reusable AI-agent harness (permissions, budgets, approval gates, evaluation traces, human-in-the-loop). Everything runs offline: in-memory storage and a deterministic fake model, no services or API keys.

**Status: work-in-progress milestone.** The deep foundations are built and tested; parallel modules, runnable demos and UX/flow checks are still landing.

| Platform | What it covers | Tests |
| --- | --- | --- |
| [`helpdesk/`](helpdesk) | Customer support: ticket state machine and SLA engine, explainable routing, knowledge retrieval with citations, agent harness, channels, notifications, automation, analytics, QA | 118 passing |
| [`contracts/`](contracts) | Legal / contract management: lifecycle state machine, versioning and provenance, obligation and date engine, clauses and playbooks, risk and approval matrix, collaboration, repository and legal hold | 59 passing |
| [`expense-procurement/`](expense-procurement) | Expenses and purchasing: approval workflow state machine, versioned policy engine, identity and permissions, audit trail, and financial integrity (money type, double-entry ledger, idempotent payments, reconciliation, three-way match) | 92 passing |

Each platform has its own `docs/DOMAIN-MAP.md` (domains mapped to modules, what is deep and what is parallel, success-criteria checks) where available.

## Run

```sh
cd helpdesk            # or contracts, expense-procurement
npm ci
npm run typecheck      # where defined
npm test
```

Requires Node 22+.
