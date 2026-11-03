import { createHash, randomUUID } from 'node:crypto';

export type EvidenceKind = 'receipt' | 'invoice' | 'purchase_order' | 'goods_receipt';

export type EvidenceLinkType = 'expense_line' | 'po';

export interface EvidenceLink {
  readonly type: EvidenceLinkType;
  readonly id: string;
}

export interface Evidence {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: EvidenceKind;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly retainUntil: string | null;
  readonly legalHold: boolean;
  readonly links: readonly EvidenceLink[];
}

export interface AddEvidenceOptions {
  readonly retainUntil?: string | Date | null;
  readonly legalHold?: boolean;
  readonly links?: readonly EvidenceLink[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function freezeRecord(record: Evidence): Evidence {
  for (const link of record.links) {
    Object.freeze(link);
  }
  Object.freeze(record.links);
  return Object.freeze(record);
}

function normalizeRetainUntil(value: string | Date | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function copyLinks(links: readonly EvidenceLink[]): EvidenceLink[] {
  return links.map((link) => ({ type: link.type, id: link.id }));
}

export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  private readonly byHash = new Map<string, string>();

  private key(tenantId: string, id: string): string {
    return tenantId + '::' + id;
  }

  private hashKey(tenantId: string, sha256: string): string {
    return tenantId + '::' + sha256;
  }

  add(tenantId: string, kind: EvidenceKind, mimeType: string, bytes: Uint8Array, opts?: AddEvidenceOptions): Evidence {
    const sha256 = sha256Hex(bytes);
    const hashKey = this.hashKey(tenantId, sha256);
    const existingId = this.byHash.get(hashKey);
    if (existingId !== undefined) {
      const existing = this.byId.get(this.key(tenantId, existingId));
      if (existing !== undefined) {
        return existing;
      }
    }
    const record: Evidence = freezeRecord({
      id: randomUUID(),
      tenantId,
      kind,
      mimeType,
      byteSize: bytes.byteLength,
      sha256,
      retainUntil: normalizeRetainUntil(opts?.retainUntil),
      legalHold: opts?.legalHold ?? false,
      links: copyLinks(opts?.links ?? []),
    });
    this.byId.set(this.key(tenantId, record.id), record);
    this.byHash.set(hashKey, record.id);
    return record;
  }

  get(tenantId: string, id: string): Evidence | undefined {
    return this.byId.get(this.key(tenantId, id));
  }

  link(tenantId: string, id: string, link: EvidenceLink): Evidence {
    const current = this.get(tenantId, id);
    if (current === undefined) {
      throw new Error('not found');
    }
    const already = current.links.some((item) => item.type === link.type && item.id === link.id);
    const links = already ? copyLinks(current.links) : [...copyLinks(current.links), { type: link.type, id: link.id }];
    const next: Evidence = freezeRecord({ ...current, links });
    this.byId.set(this.key(tenantId, id), next);
    return next;
  }

  setLegalHold(tenantId: string, id: string, on: boolean): Evidence {
    const current = this.get(tenantId, id);
    if (current === undefined) {
      throw new Error('not found');
    }
    const next: Evidence = freezeRecord({ ...current, legalHold: on, links: copyLinks(current.links) });
    this.byId.set(this.key(tenantId, id), next);
    return next;
  }

  remove(tenantId: string, id: string, now: Date): boolean {
    const current = this.get(tenantId, id);
    if (current === undefined) {
      return false;
    }
    if (current.legalHold) {
      throw new Error('legal hold');
    }
    if (current.retainUntil !== null) {
      const until = new Date(current.retainUntil).getTime();
      if (!Number.isNaN(until) && now.getTime() < until) {
        throw new Error('retention');
      }
    }
    this.byId.delete(this.key(tenantId, id));
    this.byHash.delete(this.hashKey(tenantId, current.sha256));
    return true;
  }
}
