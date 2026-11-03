/** Document metadata + retention model. Content bytes live behind a
 * BlobStore port (in-memory impl here); this module owns metadata, contract
 * linkage, checksums, retention deadlines and legal-hold enforcement.
 * Deletion is blocked by legal hold and by retention, in that order. */
import { createHash } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { newDocumentId, type ContractId, type DocumentId, type TenantId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';
import type { AccessContext } from '../identity/index.ts';
import { assertTenant, requirePermission } from '../identity/index.ts';
import type { AuditLog } from '../audit/index.ts';

export interface BlobStore { put(key: string, bytes: Uint8Array): void; get(key: string): Uint8Array | undefined; delete(key: string): void; }
export class MemoryBlobStore implements BlobStore {
  #m = new Map<string, Uint8Array>();
  put(k: string, b: Uint8Array): void { this.#m.set(k, b); }
  get(k: string): Uint8Array | undefined { return this.#m.get(k); }
  delete(k: string): void { this.#m.delete(k); }
}

export interface DocumentRecord {
  readonly id: DocumentId; readonly tenantId: TenantId;
  readonly contractId: ContractId | null; readonly name: string;
  readonly mimeType: string; readonly sizeBytes: number; readonly sha256: string;
  readonly uploadedBy: UserId; readonly uploadedAt: string;
  readonly retentionUntil: string | null; readonly legalHold: boolean;
  readonly tags: readonly string[];
}

export class DocumentService {
  #docs = new Map<DocumentId, DocumentRecord>();
  readonly #blobs: BlobStore; readonly #clock: Clock; readonly #audit: AuditLog;
  constructor(deps: { blobs: BlobStore; clock: Clock; audit: AuditLog }) {
    this.#blobs = deps.blobs; this.#clock = deps.clock; this.#audit = deps.audit;
  }
  upload(ctx: AccessContext, input: { name: string; mimeType: string; bytes: Uint8Array; contractId?: ContractId; retentionDays?: number; tags?: string[] }): DocumentRecord {
    requirePermission(ctx, 'document:write');
    if (input.bytes.length === 0) throw new DomainError('VALIDATION', 'empty document');
    const id = newDocumentId();
    const now = this.#clock.now();
    const retentionUntil = input.retentionDays === undefined ? null
      : new Date(now.getTime() + input.retentionDays * 86_400_000).toISOString();
    const rec: DocumentRecord = {
      id, tenantId: ctx.tenantId, contractId: input.contractId ?? null,
      name: input.name, mimeType: input.mimeType, sizeBytes: input.bytes.length,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      uploadedBy: ctx.userId, uploadedAt: now.toISOString(),
      retentionUntil, legalHold: false, tags: input.tags ?? [],
    };
    this.#blobs.put(id, input.bytes);
    this.#docs.set(id, rec);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'document.created', subjectType: 'document', subjectId: id, detail: { name: rec.name, sha256: rec.sha256 } });
    return rec;
  }
  get(ctx: AccessContext, id: DocumentId): DocumentRecord {
    requirePermission(ctx, 'document:read');
    const d = this.#docs.get(id);
    if (!d) throw new DomainError('NOT_FOUND', `document not found: ${id}`);
    assertTenant(ctx, d.tenantId);
    return d;
  }
  download(ctx: AccessContext, id: DocumentId): Uint8Array {
    const d = this.get(ctx, id);
    const bytes = this.#blobs.get(id);
    if (!bytes) throw new DomainError('INTEGRITY', `blob missing for document: ${id}`);
    if (createHash('sha256').update(bytes).digest('hex') !== d.sha256)
      throw new DomainError('INTEGRITY', `checksum mismatch for document: ${id}`);
    return bytes;
  }
  listForContract(ctx: AccessContext, contractId: ContractId): DocumentRecord[] {
    requirePermission(ctx, 'document:read');
    return [...this.#docs.values()].filter((d) => d.tenantId === ctx.tenantId && d.contractId === contractId);
  }
  setLegalHold(ctx: AccessContext, id: DocumentId, held: boolean): DocumentRecord {
    const d = this.get(ctx, id);
    const updated = { ...d, legalHold: held };
    this.#docs.set(id, updated);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: held ? 'document.hold.placed' : 'document.hold.released', subjectType: 'document', subjectId: id });
    return updated;
  }
  delete(ctx: AccessContext, id: DocumentId): void {
    requirePermission(ctx, 'document:delete');
    const d = this.get(ctx, id);
    if (d.legalHold) throw new DomainError('LEGAL_HOLD', `document under legal hold: ${id}`);
    if (d.retentionUntil && d.retentionUntil > this.#clock.now().toISOString())
      throw new DomainError('RETENTION', `document retained until ${d.retentionUntil}`, { retentionUntil: d.retentionUntil });
    this.#blobs.delete(id); this.#docs.delete(id);
    this.#audit.append({ tenantId: ctx.tenantId, actorId: ctx.userId, action: 'document.deleted', subjectType: 'document', subjectId: id });
  }
}
