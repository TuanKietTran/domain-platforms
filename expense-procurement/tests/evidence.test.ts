import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore, sha256Hex } from '../src/documents/evidence.js';

const enc = new TextEncoder();
const bytesOf = (text: string): Uint8Array => enc.encode(text);

describe('sha256Hex', () => {
  it('hash correctness against a known sha256 of abc', () => {
    assert.equal(sha256Hex(bytesOf('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('EvidenceStore', () => {
  it('idempotent add returns the existing record for same bytes in same tenant', () => {
    const store = new EvidenceStore();
    const first = store.add('tenant-a', 'receipt', 'application/pdf', bytesOf('hello'));
    const second = store.add('tenant-a', 'receipt', 'application/pdf', bytesOf('hello'));
    assert.equal(second.id, first.id);
    assert.equal(second, first);
  });
  it('same bytes in another tenant is a different record', () => {
    const store = new EvidenceStore();
    const a = store.add('tenant-a', 'receipt', 'text/plain', bytesOf('shared'));
    const b = store.add('tenant-b', 'receipt', 'text/plain', bytesOf('shared'));
    assert.notEqual(b.id, a.id);
    assert.equal(a.sha256, b.sha256);
    assert.equal(b.tenantId, 'tenant-b');
  });
  it('cross-tenant get is undefined', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'invoice', 'application/pdf', bytesOf('secret'));
    assert.equal(store.get('tenant-b', rec.id), undefined);
    assert.equal(store.get('tenant-a', rec.id), rec);
  });
  it('records are frozen', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'receipt', 'image/png', bytesOf('png-data'));
    assert.ok(Object.isFrozen(rec));
    assert.ok(Object.isFrozen(rec.links));
  });
  it('size is recorded', () => {
    const store = new EvidenceStore();
    const bytes = bytesOf('123456789');
    const rec = store.add('tenant-a', 'receipt', 'text/plain', bytes);
    assert.equal(rec.byteSize, 9);
    assert.equal(rec.byteSize, bytes.byteLength);
    assert.equal(rec.sha256, sha256Hex(bytes));
  });
  it('link makes a new version and leaves the old object unchanged', () => {
    const store = new EvidenceStore();
    const original = store.add('tenant-a', 'purchase_order', 'application/pdf', bytesOf('po-data'));
    const linked = store.link('tenant-a', original.id, { type: 'po', id: 'po-1' });
    assert.notEqual(linked, original);
    assert.equal(original.links.length, 0);
    assert.deepEqual(linked.links, [{ type: 'po', id: 'po-1' }]);
    assert.ok(Object.isFrozen(linked));
    assert.equal(store.get('tenant-a', original.id), linked);
  });
  it('legal hold blocks removal', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'receipt', 'application/pdf', bytesOf('held'));
    store.setLegalHold('tenant-a', rec.id, true);
    assert.throws(() => store.remove('tenant-a', rec.id, new Date()), /legal hold/);
    assert.notEqual(store.get('tenant-a', rec.id), undefined);
  });
  it('removing the legal hold allows removal', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'receipt', 'application/pdf', bytesOf('held-then-released'));
    store.setLegalHold('tenant-a', rec.id, true);
    store.setLegalHold('tenant-a', rec.id, false);
    assert.equal(store.remove('tenant-a', rec.id, new Date()), true);
    assert.equal(store.get('tenant-a', rec.id), undefined);
  });
  it('retention blocks removal before retainUntil', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'invoice', 'application/pdf', bytesOf('retained'), { retainUntil: '2030-01-01T00:00:00.000Z' });
    assert.throws(() => store.remove('tenant-a', rec.id, new Date('2029-12-31T00:00:00.000Z')), /retention/);
    assert.notEqual(store.get('tenant-a', rec.id), undefined);
  });
  it('removal succeeds after retention', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'invoice', 'application/pdf', bytesOf('retained-later'), { retainUntil: '2030-01-01T00:00:00.000Z' });
    assert.equal(store.remove('tenant-a', rec.id, new Date('2030-01-01T00:00:00.000Z')), true);
    assert.equal(store.get('tenant-a', rec.id), undefined);
  });
  it('removal succeeds when there is no retention or hold', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'goods_receipt', 'application/pdf', bytesOf('free-to-remove'));
    assert.equal(store.remove('tenant-a', rec.id, new Date()), true);
    assert.equal(store.get('tenant-a', rec.id), undefined);
  });
  it('stores kind, mime type and default fields', () => {
    const store = new EvidenceStore();
    const rec = store.add('tenant-a', 'goods_receipt', 'image/jpeg', bytesOf('jpeg'));
    assert.equal(rec.kind, 'goods_receipt');
    assert.equal(rec.mimeType, 'image/jpeg');
    assert.equal(rec.retainUntil, null);
    assert.equal(rec.legalHold, false);
    assert.deepEqual(rec.links, []);
  });
});
