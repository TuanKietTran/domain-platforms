import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffClauses } from '../src/collaboration/redline.ts';

test('added clause', () => {
  assert.deepEqual(diffClauses([], [{ id: 'a', text: 'Hello world' }]), [
    { kind: 'added', clauseId: 'a', after: 'Hello world' },
  ]);
});

test('removed clause', () => {
  assert.deepEqual(diffClauses([{ id: 'a', text: 'Hello world' }], []), [
    { kind: 'removed', clauseId: 'a', before: 'Hello world' },
  ]);
});

test('changed clause with word ops', () => {
  const result = diffClauses(
    [{ id: 'a', text: 'the quick brown fox' }],
    [{ id: 'a', text: 'the quick red fox jumps' }],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'changed');
  assert.equal(result[0]?.before, 'the quick brown fox');
  assert.equal(result[0]?.after, 'the quick red fox jumps');
  assert.deepEqual(result[0]?.words, [
    { op: 'keep', text: 'the' },
    { op: 'keep', text: 'quick' },
    { op: 'del', text: 'brown' },
    { op: 'add', text: 'red' },
    { op: 'keep', text: 'fox' },
    { op: 'add', text: 'jumps' },
  ]);
});

test('unchanged clause', () => {
  assert.deepEqual(
    diffClauses([{ id: 'a', text: 'Same text' }], [{ id: 'a', text: 'Same text' }]),
    [{ kind: 'unchanged', clauseId: 'a', before: 'Same text', after: 'Same text' }],
  );
});

test('ordering: after order first, then removed in before order', () => {
  const result = diffClauses(
    [
      { id: 'old1', text: 'X' },
      { id: 'b', text: 'B' },
      { id: 'old2', text: 'Y' },
    ],
    [
      { id: 'c', text: 'C' },
      { id: 'b', text: 'B' },
    ],
  );
  assert.deepEqual(
    result.map((change) => [change.clauseId, change.kind]),
    [
      ['c', 'added'],
      ['b', 'unchanged'],
      ['old1', 'removed'],
      ['old2', 'removed'],
    ],
  );
});

test('determinism: same input twice gives same output and does not mutate inputs', () => {
  const before = [{ id: 'a', text: 'one two three' }];
  const after = [{ id: 'a', text: 'one changed three four' }];
  const first = diffClauses(before, after);
  const second = diffClauses(before, after);
  assert.deepEqual(first, second);
  assert.deepEqual(before, [{ id: 'a', text: 'one two three' }]);
  assert.deepEqual(after, [{ id: 'a', text: 'one changed three four' }]);
});

test('empty inputs', () => {
  assert.deepEqual(diffClauses([], []), []);
});

test('whitespace-only change is changed with all words kept', () => {
  const result = diffClauses(
    [{ id: 'a', text: 'hello world' }],
    [{ id: 'a', text: 'hello   world' }],
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'changed');
  assert.equal(result[0]?.before, 'hello world');
  assert.equal(result[0]?.after, 'hello   world');
  assert.deepEqual(result[0]?.words, [
    { op: 'keep', text: 'hello' },
    { op: 'keep', text: 'world' },
  ]);
});
