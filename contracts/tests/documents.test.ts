import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/core/errors.ts';
import { makeWorld, SAMPLE_CONTENT } from './helpers.ts';

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
const bytes = (s: string) => new TextEncoder().encode(s);

test('upload stores bytes with checksum; download verifies integrity', () => {
  const w = makeWorld();
  const c = w.contracts.create(w.counselCtx, { kind: 'msa', counterparty: 'Globex', content: SAMPLE_CONTENT });
  const doc = w.documents.upload(w.counselCtx, { name: 'signed.pdf', mimeType: 'application/pdf', bytes: bytes('PDFDATA'), contractId: c.id });
  assert.equal(doc.sizeBytes, 7);
  assert.equal(new TextDecoder().decode(w.documents.download(w.counselCtx, doc.id)), 'PDFDATA');
  assert.deepEqual(w.documents.listForContract(w.counselCtx, c.id).map((d) => d.id), [doc.id]);
});

test('legal hold blocks deletion; retention blocks deletion until it lapses', () => {
  const w = makeWorld();
  const held = w.documents.upload(w.adminCtx, { name: 'a.txt', mimeType: 'text/plain', bytes: bytes('x') });
  w.documents.setLegalHold(w.adminCtx, held.id, true);
  assert.throws(() => w.documents.delete(w.adminCtx, held.id), isCode('LEGAL_HOLD'));
  w.documents.setLegalHold(w.adminCtx, held.id, false);
  w.documents.delete(w.adminCtx, held.id);
  assert.throws(() => w.documents.get(w.adminCtx, held.id), isCode('NOT_FOUND'));

  const retained = w.documents.upload(w.adminCtx, { name: 'b.txt', mimeType: 'text/plain', bytes: bytes('y'), retentionDays: 30 });
  assert.throws(() => w.documents.delete(w.adminCtx, retained.id), isCode('RETENTION'));
  w.clock.advanceDays(31);
  w.documents.delete(w.adminCtx, retained.id); // retention lapsed
});

test('documents are tenant-scoped and delete requires permission', () => {
  const w = makeWorld();
  const doc = w.documents.upload(w.counselCtx, { name: 'a.txt', mimeType: 'text/plain', bytes: bytes('x') });
  assert.throws(() => w.documents.get(w.outsiderCtx, doc.id), isCode('TENANT_MISMATCH'));
  assert.throws(() => w.documents.delete(w.counselCtx, doc.id), isCode('FORBIDDEN')); // counsel lacks document:delete
});
