import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FakeClock } from '../src/core/clock.js';
import { DomainError } from '../src/core/errors.js';
import { asTenantId, asUserId, SequentialIdGenerator } from '../src/core/ids.js';
import { KnowledgeRetriever, makeSnippet, searchKnowledge, tokenize } from '../src/knowledge/retrieval.js';
import { InMemoryKnowledgeStore, KnowledgeStore, normalizeTags } from '../src/knowledge/store.js';

const tenantA = asTenantId('tenant-a');
const tenantB = asTenantId('tenant-b');
const author = asUserId('usr_1');

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof DomainError && err.code === code);
}

function newStore(): KnowledgeStore {
  return new KnowledgeStore(new SequentialIdGenerator(), new FakeClock('2026-01-05T09:00:00.000Z'));
}

function published(store: KnowledgeStore, title: string, body: string, tags: readonly string[] = []) {
  const article = store.create({ tenantId: tenantA, title, body, tags, authorId: author });
  return store.publish(article.id, tenantA);
}

test('create trims title, normalizes tags, starts as draft v1 with clock timestamps', () => {
  const store = newStore();
  const article = store.create({ tenantId: tenantA, title: '  Reset password  ', body: '  Open settings.  ', tags: [' Account ', 'account', '', 'SSO'], authorId: author, changeNote: 'init' });
  assert.equal(article.id, 'art_000001');
  assert.equal(article.title, 'Reset password');
  assert.deepEqual(article.tags, ['account', 'sso']);
  assert.equal(article.status, 'draft');
  assert.equal(article.currentVersion, 1);
  assert.equal(article.createdAt, '2026-01-05T09:00:00.000Z');
  assert.equal(article.updatedAt, '2026-01-05T09:00:00.000Z');
  const v1 = store.getCurrentVersion(article.id, tenantA);
  assert.equal(v1.version, 1);
  assert.equal(v1.body, 'Open settings.');
  assert.equal(v1.authorId, author);
  assert.equal(v1.changeNote, 'init');
  assert.equal(InMemoryKnowledgeStore, KnowledgeStore);
});

test('create rejects a short title and a blank body with VALIDATION', () => {
  const store = newStore();
  throwsCode(() => store.create({ tenantId: tenantA, title: ' x ', body: 'body' }), 'VALIDATION');
  throwsCode(() => store.create({ tenantId: tenantA, title: 'Valid title', body: '   ' }), 'VALIDATION');
  assert.equal(store.list(tenantA).length, 0);
});

test('normalizeTags lowercases, trims, dedupes and drops empties', () => {
  assert.deepEqual(normalizeTags([' B ', 'a', 'B', '', '  ']), ['b', 'a']);
  assert.deepEqual(normalizeTags([]), []);
});

test('get is tenant-scoped: another tenant and an unknown id both read as NOT_FOUND', () => {
  const store = newStore();
  const article = store.create({ tenantId: tenantA, title: 'Private article', body: 'secret body' });
  throwsCode(() => store.get(article.id, tenantB), 'NOT_FOUND');
  throwsCode(() => store.getCurrentVersion(article.id, tenantB), 'NOT_FOUND');
  throwsCode(() => store.listVersions(article.id, tenantB), 'NOT_FOUND');
});

test('list filters by tenant, status and all requested tags, sorted by id', () => {
  const store = newStore();
  const a1 = published(store, 'First article', 'body one', ['account', 'sso']);
  store.create({ tenantId: tenantA, title: 'Second article', body: 'body two', tags: ['account'] });
  const other = store.create({ tenantId: tenantB, title: 'Other tenant', body: 'body three', tags: ['account', 'sso'] });
  store.publish(other.id, tenantB);
  assert.deepEqual(store.list(tenantA).map((a) => a.id), [a1.id, store.list(tenantA)[1]?.id]);
  assert.deepEqual(store.list(tenantA, { status: 'published' }).map((a) => a.id), [a1.id]);
  assert.deepEqual(store.list(tenantA, { status: 'draft' }).length, 1);
  assert.deepEqual(store.list(tenantA, { tags: ['Account', 'SSO'] }).map((a) => a.id), [a1.id]);
  assert.deepEqual(store.list(tenantA, { tags: ['account'] }).length, 2);
  assert.deepEqual(store.list(tenantB).map((a) => a.id), [other.id]);
});

test('update appends a version, mirrors title/tags, and preserves unspecified fields', () => {
  const store = newStore();
  const article = store.create({ tenantId: tenantA, title: 'Old title', body: 'old body', tags: ['old'] });
  const updated = store.update(article.id, tenantA, { body: 'new body', changeNote: 'fix' });
  assert.equal(updated.currentVersion, 2);
  assert.equal(updated.title, 'Old title');
  assert.deepEqual(updated.tags, ['old']);
  assert.equal(store.getVersion(article.id, tenantA, 1).body, 'old body');
  assert.equal(store.getVersion(article.id, tenantA, 2).body, 'new body');
  assert.equal(store.getVersion(article.id, tenantA, 2).changeNote, 'fix');
  assert.equal(store.getCurrentVersion(article.id, tenantA).version, 2);
  assert.deepEqual(store.listVersions(article.id, tenantA).map((v) => v.version), [1, 2]);
  const retitled = store.update(article.id, tenantA, { title: 'New title', tags: ['Fresh'] });
  assert.equal(retitled.title, 'New title');
  assert.deepEqual(retitled.tags, ['fresh']);
  assert.equal(retitled.currentVersion, 3);
});

test('update validates input, version lookup misses, and tenant scope', () => {
  const store = newStore();
  const article = store.create({ tenantId: tenantA, title: 'Some article', body: 'body' });
  throwsCode(() => store.update(article.id, tenantA, {}), 'VALIDATION');
  throwsCode(() => store.update(article.id, tenantA, { title: 'x' }), 'VALIDATION');
  throwsCode(() => store.update(article.id, tenantA, { body: ' ' }), 'VALIDATION');
  throwsCode(() => store.update(article.id, tenantB, { body: 'hijack' }), 'NOT_FOUND');
  throwsCode(() => store.getVersion(article.id, tenantA, 99), 'NOT_FOUND');
  assert.equal(store.get(article.id, tenantA).currentVersion, 1);
});

test('publish and archive change status idempotently without creating a version', () => {
  const store = newStore();
  const article = store.create({ tenantId: tenantA, title: 'Lifecycle article', body: 'body' });
  assert.equal(store.publish(article.id, tenantA).status, 'published');
  assert.equal(store.publish(article.id, tenantA).status, 'published');
  assert.equal(store.archive(article.id, tenantA).status, 'archived');
  assert.equal(store.get(article.id, tenantA).currentVersion, 1);
  assert.equal(store.listVersions(article.id, tenantA).length, 1);
});

test('tokenize lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens', () => {
  assert.deepEqual(tokenize('The password, and the RESET! a b SSO-365'), ['password', 'reset', 'sso', '365']);
  assert.deepEqual(tokenize('the and of'), []);
  assert.deepEqual(tokenize(''), []);
});

test('makeSnippet picks the first sentence containing a term, else the first sentence, and truncates at 200', () => {
  assert.equal(makeSnippet('Billing is monthly. Reset your password in settings. More text.', ['password']), 'Reset your password in settings.');
  assert.equal(makeSnippet('First sentence here. Second one.', ['missing']), 'First sentence here.');
  const long = 'password ' + 'x'.repeat(250) + '.';
  const snippet = makeSnippet(long, ['password']);
  assert.equal(snippet.length, 200);
  assert.ok(snippet.endsWith('...'));
});

test('search returns only published articles from the queried tenant', () => {
  const store = newStore();
  published(store, 'Password reset guide', 'Reset your password from settings.');
  store.create({ tenantId: tenantA, title: 'Password draft', body: 'password draft body' });
  const archived = published(store, 'Password archived', 'password archived body');
  store.archive(archived.id, tenantA);
  const other = store.create({ tenantId: tenantB, title: 'Password other tenant', body: 'password body' });
  store.publish(other.id, tenantB);
  const hits = new KnowledgeRetriever(store).search({ tenantId: tenantA, text: 'password' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, 'Password reset guide');
});

test('search ranks a title-and-body match above a body-only mention, with a full citation', () => {
  const store = newStore();
  const weak = published(store, 'Billing invoice', 'Your invoice history. A password is mentioned once.');
  const strong = published(store, 'Reset password', 'How to reset your password. Open settings and choose reset password to regain access.');
  const hits = new KnowledgeRetriever(store).search({ tenantId: tenantA, text: 'reset password' });
  assert.deepEqual(hits.map((h) => h.articleId), [strong.id, weak.id]);
  const top = hits[0];
  assert.ok(top && top.score > 0);
  assert.deepEqual(top.matchedTerms, ['reset', 'password']);
  assert.equal(top.version, 1);
  assert.equal(top.snippet, 'How to reset your password.');
  assert.deepEqual(top.citation, { articleId: strong.id, version: 1, title: 'Reset password', snippet: top.snippet });
});

test('search cites the current version after an update, not the superseded text', () => {
  const store = newStore();
  const article = published(store, 'Password help', 'Old password procedure from version one.');
  store.update(article.id, tenantA, { body: 'New password procedure from version two.' });
  const hits = searchKnowledge(store, { tenantId: tenantA, text: 'password procedure' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.version, 2);
  assert.equal(hits[0]?.citation.version, 2);
  assert.equal(hits[0]?.snippet, 'New password procedure from version two.');
});

test('search honours tag filters, limit, and empty or stopword-only queries', () => {
  const store = newStore();
  published(store, 'Password one', 'password body one', ['account']);
  published(store, 'Password two', 'password body two', ['billing']);
  published(store, 'Password three', 'password body three', ['account']);
  const retriever = new KnowledgeRetriever(store);
  assert.equal(retriever.search({ tenantId: tenantA, text: 'password', tags: ['account'] }).length, 2);
  assert.equal(retriever.search({ tenantId: tenantA, text: 'password', limit: 2 }).length, 2);
  assert.deepEqual(retriever.search({ tenantId: tenantA, text: 'password', limit: 0 }), []);
  assert.deepEqual(retriever.search({ tenantId: tenantA, text: 'the and of' }), []);
  assert.deepEqual(retriever.search({ tenantId: tenantA, text: 'nonexistentterm' }), []);
});

test('search breaks score ties by articleId ascending, deterministically', () => {
  const store = newStore();
  const first = published(store, 'Same title', 'identical password body');
  const second = published(store, 'Same title', 'identical password body');
  const hits = new KnowledgeRetriever(store).search({ tenantId: tenantA, text: 'password' });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.score, hits[1]?.score);
  assert.deepEqual(hits.map((h) => h.articleId), [first.id, second.id]);
});
