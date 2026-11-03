import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditLog, type AuditEntry } from '../../src/core/audit.js';
import { DomainError } from '../../src/core/errors.js';
import { EventBus, EventStore } from '../../src/core/events.js';
import { IdempotencyStore } from '../../src/core/idempotency.js';
import { asCustomerId, asTenantId, asUserId } from '../../src/core/ids.js';
import { TicketService, type TicketServiceDeps } from '../../src/tickets/service.js';
import type { Principal } from '../../src/core/tenancy.js';
import type { CreateTicketInput } from '../../src/tickets/types.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const now = () => '2026-01-05T09:00:00.000Z';

function makeHarness() {
  let sequence = 0;
  const idGenerator = {
    next: (prefix: string) => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
  };
  const clock = { now: () => new Date(now()) };
  const audit = new AuditLog(clock, idGenerator);
  const deps = {
    clock,
    ids: idGenerator,
    events: new EventStore(clock, idGenerator),
    bus: new EventBus(),
    audit,
    idempotency: new IdempotencyStore(now),
    sla: {
      selectPolicy: () => {
        throw new DomainError('NOT_FOUND', 'No SLA policy configured');
      },
      createTracker: () => {
        throw new DomainError('NOT_FOUND', 'No SLA policy configured');
      },
    },
    routing: {
      decide: (request: { priority: string; tags: readonly string[] }) => ({
        priority: request.priority,
        tags: [...request.tags],
        matchedRules: [],
      }),
    },
  } as unknown as TicketServiceDeps;
  return { service: new TicketService(deps), audit };
}

function principalFor(tenantId: typeof tenantA, userId: string): Principal {
  return {
    tenantId,
    userId: asUserId(userId),
    roles: ['admin'],
    permissions: new Set(['ticket:create', 'ticket:read']),
  };
}

function createInput(tenantId: typeof tenantA, idempotencyKey: string): CreateTicketInput {
  return {
    tenantId,
    subject: 'Cannot sign in to the portal',
    description: 'The customer is locked out after several failed attempts.',
    requesterId: asCustomerId('customer-1'),
    channel: 'email',
    idempotencyKey,
  } as CreateTicketInput;
}

test('creating twice with the same idempotency key returns the same ticket and audits one creation', async () => {
  const { service, audit } = makeHarness();
  const principal = principalFor(tenantA, 'user-1');
  const input = createInput(tenantA, 'create-key-1');

  const first = await service.createTicket(principal, input);
  const second = await service.createTicket(principal, input);

  assert.equal(second.id, first.id);
  const creations = audit.list(tenantA).filter((entry) => entry.action === 'ticket.create');
  assert.equal(creations.length, 1);
});

test('a different tenant using the same key gets a different ticket', async () => {
  const { service } = makeHarness();

  const first = await service.createTicket(principalFor(tenantA, 'user-1'), createInput(tenantA, 'shared-key'));
  const other = await service.createTicket(principalFor(tenantB, 'user-2'), createInput(tenantB, 'shared-key'));

  assert.notEqual(other.id, first.id);
  assert.equal(other.tenantId, tenantB);
});

test('reading a ticket from another tenant is denied', async () => {
  const { service } = makeHarness();
  const created = await service.createTicket(principalFor(tenantA, 'user-1'), createInput(tenantA, 'create-key-1'));

  assert.throws(() => service.get(principalFor(tenantB, 'user-2'), created.id), DomainError);
});

test('the audit log verifies until one entry is tampered with', async () => {
  const { service, audit } = makeHarness();
  await service.createTicket(principalFor(tenantA, 'user-1'), createInput(tenantA, 'create-key-1'));

  assert.equal(audit.verify().valid, true);
  const entries = audit.list(tenantA);
  assert.ok(entries.length > 0);
  // Stored entries are deep-frozen, so tampering is simulated the same way
  // audit.test.ts simulates dropped entries: replace an entry in the
  // log's storage with a forged copy, then verify() must reject the chain.
  const internals = audit as unknown as { entries: AuditEntry[] };
  const idx = internals.entries.findIndex((entry) => entry.id === entries[0]?.id);
  assert.ok(idx >= 0);
  internals.entries[idx] = { ...internals.entries[idx], summary: 'tampered summary' } as AuditEntry;
  assert.equal(audit.verify().valid, false);
});
