import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { ClauseLibrary } from '../src/clauses/library.ts';
import { PlaybookService } from '../src/clauses/playbook.ts';
import { makeWorld } from './helpers.ts';

function setup() {
  const w = makeWorld();
  return { w, lib: new ClauseLibrary({ clock: w.clock, audit: w.audit }), pb: new PlaybookService({ clock: w.clock, audit: w.audit }) };
}

test('clause upsert versions, enforces write permission and tenant scope', () => {
  const { w, lib } = setup();
  const v1 = lib.upsertClause(w.contributorCtx, { key: 'confidentiality', title: 'Confidentiality', body: 'Each party keeps confidential information secret.', category: 'boilerplate', riskLevel: 'low' });
  assert.equal(v1.version, 1);
  const v2 = lib.upsertClause(w.counselCtx, { key: 'confidentiality', title: 'Confidentiality', body: 'Each party keeps all confidential information secret.', category: 'boilerplate', riskLevel: 'low' });
  assert.equal(v2.version, 2);
  assert.equal(lib.getClause(w.viewerCtx, 'confidentiality').version, 2);
  assert.throws(() => lib.upsertClause(w.viewerCtx, { key: 'x', title: 'X', body: 'Y', category: 'c', riskLevel: 'low' }),
    (e: unknown) => e instanceof DomainError && e.code === 'FORBIDDEN');
  assert.throws(() => lib.getClause(w.outsiderCtx, 'confidentiality'),
    (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND');
});

test('templates only reference existing clauses and materialize in order', () => {
  const { w, lib } = setup();
  assert.throws(() => lib.upsertTemplate(w.counselCtx, { key: 'msa', title: 'MSA', clauseKeys: ['confidentiality'] }),
    (e: unknown) => e instanceof DomainError && e.code === 'VALIDATION');
  lib.upsertClause(w.counselCtx, { key: 'confidentiality', title: 'Confidentiality', body: 'Each party keeps confidential information secret.', category: 'boilerplate', riskLevel: 'low' });
  lib.upsertClause(w.counselCtx, { key: 'term', title: 'Term', body: 'Initial term of 12 months.', category: 'commercial', riskLevel: 'medium' });
  const t = lib.upsertTemplate(w.counselCtx, { key: 'msa', title: 'Master Services Agreement', clauseKeys: ['term', 'confidentiality'] });
  assert.equal(t.version, 1);
  const content = lib.materialize(w.viewerCtx, 'msa');
  assert.equal(content.title, 'Master Services Agreement');
  assert.deepEqual(content.clauses.map((c) => c.id), ['term', 'confidentiality']);
});

test('playbook deviations: preferred none, fallback minor, unacceptable/missing major', () => {
  const { w, pb } = setup();
  pb.upsertPlaybook(w.counselCtx, { key: 'std', title: 'Standard', positions: [
    { clauseKey: 'liability', preferred: 'liability is capped at fees paid', fallback: 'liability is capped at 12 months of fees', unacceptable: 'unlimited liability', note: '' },
    { clauseKey: 'confidentiality', preferred: 'confidential information', fallback: 'business information', unacceptable: '', note: '' },
  ] });
  const content = { title: 'Deal', clauses: [
    { id: 'liability', heading: 'Liability', body: 'Liability is capped at 12 months of fees.' },
    { id: 'confidentiality', heading: 'Confidentiality', body: 'Each party protects confidential information.' },
  ] };
  const devs = pb.assessDeviations(w.viewerCtx, 'std', content);
  assert.deepEqual(devs.map((d) => [d.clauseKey, d.severity]), [['liability', 'minor'], ['confidentiality', 'none']]);
  const bad = pb.assessDeviations(w.viewerCtx, 'std', { title: 'Bad', clauses: [
    { id: 'liability', heading: 'Liability', body: 'Supplier accepts unlimited liability.' },
  ] });
  assert.deepEqual(bad.map((d) => d.severity), ['major', 'major']); // unacceptable wording + missing clause
});
