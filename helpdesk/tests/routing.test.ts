import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DomainError } from '../src/core/errors.js';
import { asTeamId, asTenantId, asUserId } from '../src/core/ids.js';
import { RoutingEngine, type RoutingAgent, type RoutingRequest } from '../src/routing/engine.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const team1 = asTeamId('team-1');
const team2 = asTeamId('team-2');
const u1 = asUserId('usr_1');
const u2 = asUserId('usr_2');
const u3 = asUserId('usr_3');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

function req(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    tenantId: tenantA,
    channel: 'email',
    priority: 'normal',
    tags: [],
    subject: 'Password reset',
    description: 'User cannot log in',
    ...overrides,
  };
}

function agent(userId: typeof u1, overrides: Partial<RoutingAgent> = {}): RoutingAgent {
  return { userId, ...overrides };
}

test('no matching rules leaves the ticket unassigned with request priority and tags', () => {
  const engine = new RoutingEngine();
  const d = engine.decide(req({ tags: ['vip', 'vip'] }));
  assert.equal(d.priority, 'normal');
  assert.deepEqual(d.tags, ['vip']);
  assert.equal(d.teamId, undefined);
  assert.equal(d.assigneeId, undefined);
  assert.deepEqual(d.matchedRules, []);
  assert.equal(d.explanation, 'No routing rules matched; ticket left unassigned with the requested priority and tags.');
  assert.ok(Object.isFrozen(d));
});

test('a rule matches only when every present condition facet matches', () => {
  const engine = new RoutingEngine({
    rules: [{
      id: 'full', priority: 10,
      conditions: {
        channels: ['email'], priorities: ['normal'], tagsAny: ['login', 'billing'],
        tagsAll: ['vip'], languages: ['en'], productIds: ['core'],
        keywordsAny: ['PASSWORD'], keywordsAll: ['reset', 'log in'],
      },
      teamId: team1,
    }],
  });
  const d = engine.decide(req({ tags: ['vip', 'login'], language: 'en', productId: 'core' }));
  assert.equal(d.teamId, team1);
  assert.equal(d.matchedRules.length, 1);
  const reason = d.matchedRules[0].reason;
  for (const facet of ['channel=email', 'priority=normal', 'tagsAny=login', 'tagsAll=vip', 'language=en', 'productId=core', 'keywordsAny=PASSWORD', 'keywordsAll=reset,log in']) {
    assert.ok(reason.includes(facet), facet);
  }
});

test('any single failing facet prevents a match', () => {
  const base = { priority: 10, teamId: team1 };
  const engine = new RoutingEngine({
    rules: [
      { ...base, id: 'bad-channel', conditions: { channels: ['phone'] } },
      { ...base, id: 'bad-priority', conditions: { priorities: ['urgent'] } },
      { ...base, id: 'bad-tags-all', conditions: { tagsAll: ['vip', 'missing'] } },
      { ...base, id: 'bad-tags-any', conditions: { tagsAny: ['nope'] } },
      { ...base, id: 'bad-language', conditions: { languages: ['fr'] } },
      { ...base, id: 'bad-product', conditions: { productIds: ['other'] } },
      { ...base, id: 'bad-keywords-any', conditions: { keywordsAny: ['refund'] } },
      { ...base, id: 'bad-keywords-all', conditions: { keywordsAll: ['reset', 'refund'] } },
    ],
  });
  const d = engine.decide(req({ tags: ['vip'], language: 'en', productId: 'core' }));
  assert.deepEqual(d.matchedRules, []);
  assert.equal(d.teamId, undefined);
});

test('a conditionless rule matches everything and reports no conditions', () => {
  const engine = new RoutingEngine({ rules: [{ id: 'catch-all', priority: 1, addTags: ['routed'] }] });
  const d = engine.decide(req());
  assert.equal(d.matchedRules[0].reason, 'Rule catch-all matched (no conditions)');
  assert.deepEqual(d.tags, ['routed']);
});

test('a custom rule reason replaces the generated facet reason', () => {
  const engine = new RoutingEngine({ rules: [{ id: 'r', priority: 1, reason: 'VIP desk', teamId: team1 }] });
  assert.equal(engine.decide(req()).matchedRules[0].reason, 'VIP desk');
});

test('rules run by priority desc then id asc; first wins team/priority/assignee, tags accumulate', () => {
  const engine = new RoutingEngine({
    rules: [
      { id: 'r-low', priority: 10, setPriority: 'high', teamId: team2, addTags: ['low-tag'] },
      { id: 'r-high', priority: 20, setPriority: 'urgent', teamId: team1, addTags: ['high-tag'] },
    ],
  });
  const d = engine.decide(req({ tags: ['base'] }));
  assert.equal(d.priority, 'urgent');
  assert.equal(d.teamId, team1);
  assert.deepEqual(d.tags, ['base', 'high-tag', 'low-tag']);
  assert.deepEqual(d.matchedRules.map((m) => m.ruleId), ['r-high', 'r-low']);
  assert.ok(d.explanation.endsWith('=> priority=urgent, team=team-1, assignee=none'));
  const tie = new RoutingEngine({
    rules: [
      { id: 'r-b', priority: 5, teamId: team2 },
      { id: 'r-a', priority: 5, teamId: team1 },
    ],
  });
  assert.equal(tie.decide(req()).teamId, team1);
});

test('disabled rules and rules scoped to another tenant are ignored', () => {
  const engine = new RoutingEngine({
    rules: [
      { id: 'off', priority: 30, enabled: false, teamId: team2 },
      { id: 'other-tenant', priority: 20, tenantId: tenantB, teamId: team2 },
      { id: 'global', priority: 10, teamId: team1 },
    ],
  });
  const a = engine.decide(req());
  assert.deepEqual(a.matchedRules.map((m) => m.ruleId), ['global']);
  assert.equal(a.teamId, team1);
  const b = engine.decide(req({ tenantId: tenantB }));
  assert.deepEqual(b.matchedRules.map((m) => m.ruleId), ['other-tenant', 'global']);
  assert.equal(b.teamId, team2);
});

test('registerRule validates id, finite priority and duplicates', () => {
  const engine = new RoutingEngine();
  throwsCode(() => engine.registerRule({ id: '', priority: 1 }), 'VALIDATION');
  throwsCode(() => engine.registerRule({ id: 'x', priority: Number.NaN }), 'VALIDATION');
  throwsCode(() => engine.registerRule({ id: 'x', priority: Number.POSITIVE_INFINITY }), 'VALIDATION');
  engine.registerRule({ id: 'x', priority: 1 });
  throwsCode(() => engine.registerRule({ id: 'x', priority: 2 }), 'VALIDATION');
  assert.equal(engine.listRules().length, 1);
  assert.notEqual(engine.listRules(), engine.listRules());
});

test('constructor accepts a bare rule array as well as options', () => {
  const engine = new RoutingEngine([{ id: 'r', priority: 1, teamId: team1 }]);
  assert.equal(engine.decide(req()).teamId, team1);
  assert.equal(engine.listAgents().length, 0);
});

test('an explicit assignee beats candidates and the agent pool regardless of capacity', () => {
  const engine = new RoutingEngine({
    rules: [{ id: 'r', priority: 1, assigneeId: u3, candidateAssigneeIds: [u1] }],
    agents: [agent(u1), agent(u3, { capacity: 0 })],
  });
  assert.equal(engine.decide(req()).assigneeId, u3);
});

test('candidates are chosen least-loaded with userId tie-break and capacity filtering', () => {
  const engine = new RoutingEngine({
    rules: [{ id: 'r', priority: 1, candidateAssigneeIds: [u2, u1] }],
    agents: [agent(u1, { capacity: 5 }), agent(u2, { capacity: 5 })],
  });
  assert.equal(engine.decide(req(), { load: new Map([[u1, 2], [u2, 0]]) }).assigneeId, u2);
  assert.equal(engine.decide(req(), { load: new Map([[u1, 1], [u2, 1]]) }).assigneeId, u1);
  assert.equal(engine.decide(req(), { load: new Map([[u1, 5], [u2, 1]]) }).assigneeId, u2);
});

test('when no candidate is eligible the choice falls back to the candidate list itself', () => {
  const capped = new RoutingEngine({
    rules: [{ id: 'r', priority: 1, candidateAssigneeIds: [u1, u2] }],
    agents: [agent(u1, { capacity: 0 }), agent(u2, { capacity: 0 })],
  });
  assert.equal(capped.decide(req()).assigneeId, u1);
  const unknown = new RoutingEngine({ rules: [{ id: 'r', priority: 1, candidateAssigneeIds: [u3] }] });
  assert.equal(unknown.decide(req()).assigneeId, u3);
});

test('agent pool fallback filters by team, skills, language, channel, capacity and active flag', () => {
  const engine = new RoutingEngine({
    rules: [{ id: 'r', priority: 1, teamId: team1 }],
    agents: [
      agent(u1, { teamId: team2, skills: ['billing'], languages: ['en'], channels: ['email'] }),
      agent(u2, { teamId: team1, skills: ['other'], languages: ['en'], channels: ['email'] }),
      agent(u3, { teamId: team1, skills: ['billing'], languages: ['en'], channels: ['email'], capacity: 3 }),
    ],
  });
  const d = engine.decide(req({ requiredSkills: ['billing'], language: 'en' }), { load: new Map([[u3, 1]]) });
  assert.equal(d.assigneeId, u3);
  assert.equal(d.teamId, team1);
});

test('agent pool fallback drops inactive, wrong-channel and at-capacity agents and can leave a ticket unassigned', () => {
  const engine = new RoutingEngine({
    agents: [
      agent(u1, { active: false }),
      agent(u2, { channels: ['phone'] }),
      agent(u3, { capacity: 1 }),
    ],
  });
  const d = engine.decide(req(), { load: new Map([[u3, 1]]) });
  assert.equal(d.assigneeId, undefined);
});

test('without a rule team, the chosen agent supplies the team; least-loaded wins', () => {
  const engine = new RoutingEngine({ agents: [agent(u1, { teamId: team1 }), agent(u2, { teamId: team2 })] });
  const d = engine.decide(req(), { load: new Map([[u1, 3], [u2, 0]]) });
  assert.equal(d.assigneeId, u2);
  assert.equal(d.teamId, team2);
});

test('skills added by a matched rule constrain the agent pool', () => {
  const engine = new RoutingEngine({
    rules: [{ id: 'r', priority: 1, requiredSkills: ['billing'] }],
    agents: [agent(u1, { skills: ['general'] }), agent(u2, { skills: ['billing'] })],
  });
  assert.equal(engine.decide(req()).assigneeId, u2);
});

test('context agents and load override the registered agents and default load', () => {
  const engine = new RoutingEngine({ agents: [agent(u1)] });
  const d = engine.decide(req(), { agents: [agent(u2)], load: new Map() });
  assert.equal(d.assigneeId, u2);
});
