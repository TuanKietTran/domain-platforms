/** Immutable versioning + provenance. A contract's content is a chain of
 * versions; once created a version never changes. Each version records who
 * created it, from what source (human edit, template, import, agent draft),
 * and its parent, so any clause can be traced to its origin. */
import { createHash } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { newContractVersionId, type ContractId, type ContractVersionId, type UserId } from '../core/ids.ts';
import type { Clock } from '../core/clock.ts';

export type VersionSource = 'human' | 'template' | 'import' | 'agent_draft' | 'counterparty_redline';

export interface Clause { readonly id: string; readonly heading: string; readonly body: string; }
export interface ContractContent { readonly title: string; readonly clauses: readonly Clause[]; }

export interface ContractVersion {
  readonly id: ContractVersionId; readonly contractId: ContractId;
  readonly number: number; readonly parentId: ContractVersionId | null;
  readonly content: Readonly<ContractContent>; readonly contentHash: string;
  readonly source: VersionSource; readonly createdBy: UserId | null;
  readonly note: string; readonly createdAt: string;
}

export function contentHash(content: ContractContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export class VersionStore {
  #byContract = new Map<ContractId, ContractVersion[]>();
  readonly #clock: Clock;
  constructor(clock: Clock) { this.#clock = clock; }

  create(contractId: ContractId, content: ContractContent, opts: { source: VersionSource; createdBy: UserId | null; note?: string }): ContractVersion {
    const chain = this.#byContract.get(contractId) ?? [];
    const parent = chain[chain.length - 1] ?? null;
    if (parent && parent.contentHash === contentHash(content))
      throw new DomainError('CONFLICT', 'new version is identical to current version', { contractId });
    const v: ContractVersion = Object.freeze({
      id: newContractVersionId(), contractId,
      number: chain.length + 1, parentId: parent ? parent.id : null,
      content: Object.freeze({ title: content.title, clauses: Object.freeze(content.clauses.map((c) => Object.freeze({ ...c }))) }),
      contentHash: contentHash(content), source: opts.source,
      createdBy: opts.createdBy, note: opts.note ?? '', createdAt: this.#clock.now().toISOString(),
    });
    chain.push(v); this.#byContract.set(contractId, chain);
    return v;
  }
  current(contractId: ContractId): ContractVersion {
    const chain = this.#byContract.get(contractId);
    if (!chain || chain.length === 0) throw new DomainError('NOT_FOUND', `no versions for contract: ${contractId}`);
    return chain[chain.length - 1]!;
  }
  get(contractId: ContractId, versionId: ContractVersionId): ContractVersion {
    const v = (this.#byContract.get(contractId) ?? []).find((x) => x.id === versionId);
    if (!v) throw new DomainError('NOT_FOUND', `version not found: ${versionId}`);
    return v;
  }
  history(contractId: ContractId): ContractVersion[] { return [...(this.#byContract.get(contractId) ?? [])]; }
  /** Lineage from root to the given version (provenance chain). */
  lineage(contractId: ContractId, versionId: ContractVersionId): ContractVersion[] {
    const chain = this.#byContract.get(contractId) ?? [];
    const byId = new Map(chain.map((v) => [v.id, v]));
    const out: ContractVersion[] = [];
    let cur: ContractVersion | undefined = byId.get(versionId);
    if (!cur) throw new DomainError('NOT_FOUND', `version not found: ${versionId}`);
    while (cur) { out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  }
}

export interface ClauseDiff { readonly clauseId: string; readonly kind: 'added' | 'removed' | 'changed'; readonly before?: Clause; readonly after?: Clause; }
export function diffContent(a: ContractContent, b: ContractContent): ClauseDiff[] {
  const diffs: ClauseDiff[] = [];
  const aBy = new Map(a.clauses.map((c) => [c.id, c]));
  const bBy = new Map(b.clauses.map((c) => [c.id, c]));
  for (const [id, cb] of bBy) {
    const ca = aBy.get(id);
    if (!ca) diffs.push({ clauseId: id, kind: 'added', after: cb });
    else if (ca.heading !== cb.heading || ca.body !== cb.body) diffs.push({ clauseId: id, kind: 'changed', before: ca, after: cb });
  }
  for (const [id, ca] of aBy) if (!bBy.has(id)) diffs.push({ clauseId: id, kind: 'removed', before: ca });
  return diffs;
}
