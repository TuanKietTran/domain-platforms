import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { diffContent } from '../src/versioning/index.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

test('versions chain with parents, hashes and provenance', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const v1 = w.versions.current(c.id);
  assert.equal(v1.number, 1); assert.equal(v1.parentId, null); assert.equal(v1.source, 'human');
  const edited = { ...SAMPLE_CONTENT, clauses: SAMPLE_CONTENT.clauses.map((cl) => cl.id === 'c3' ? { ...cl, body: 'Initial term of 24 months.' } : cl) };
  w.contracts.addVersion(w.counselCtx, c.id, edited, 'extend term');
  const v2 = w.versions.current(c.id);
  assert.equal(v2.number, 2); assert.equal(v2.parentId, v1.id); assert.notEqual(v2.contentHash, v1.contentHash);
  assert.deepEqual(w.versions.lineage(c.id, v2.id).map((v) => v.number), [1, 2]);
});

test('identical content cannot create a no-op version', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  assert.throws(() => w.contracts.addVersion(w.counselCtx, c.id, SAMPLE_CONTENT),
    (e: unknown) => e instanceof DomainError && e.code === 'CONFLICT');
});

test('stored versions are immutable snapshots', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const v1 = w.versions.current(c.id);
  assert.throws(() => { (v1.content as { title: string }).title = 'Hacked'; }, TypeError);
});

test('diffContent reports added, removed and changed clauses', () => {
  const a = SAMPLE_CONTENT;
  const b = { title: 'T', clauses: [
    { id: 'c1', heading: 'Scope', body: 'Supplier will provide services as described.' },
    { id: 'c3', heading: 'Term', body: 'Initial term of 24 months.' },
    { id: 'c4', heading: 'Fees', body: 'Monthly fee applies.' },
  ] };
  const diffs = diffContent(a, b);
  assert.deepEqual(diffs.map((d) => `${d.clauseId}:${d.kind}`).sort(), ['c2:removed', 'c3:changed', 'c4:added']);
});
