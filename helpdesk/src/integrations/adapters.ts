import { SystemClock, type Clock } from '../core/clock.js';
import { DomainError } from '../core/errors.js';
import { SequentialIdGenerator, type CrmRecordId, type IdGenerator, type ProductId, type TenantId } from '../core/ids.js';
import { deepFreeze, unique } from '../core/util.js';

export interface CrmCustomer {
  readonly id: CrmRecordId;
  readonly tenantId: TenantId;
  readonly externalId: string;
  readonly name: string;
  readonly email?: string;
  readonly company?: string;
  readonly tier?: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
}

export interface UpsertCustomerInput {
  readonly tenantId: TenantId;
  readonly externalId: string;
  readonly name: string;
  readonly email?: string;
  readonly company?: string;
  readonly tier?: string;
  readonly tags?: readonly string[];
}

export interface CrmAdapter {
  readonly name: string;
  findCustomer(tenantId: TenantId, externalId: string): CrmCustomer | undefined;
  upsertCustomer(input: UpsertCustomerInput): CrmCustomer;
  listCustomers(tenantId: TenantId): readonly CrmCustomer[];
}

export interface ProductInfo {
  readonly id: ProductId;
  readonly tenantId: TenantId;
  readonly sku: string;
  readonly name: string;
  readonly version?: string;
  readonly status: 'active' | 'beta' | 'deprecated';
  readonly updatedAt: string;
}

export interface UpsertProductInput {
  readonly tenantId: TenantId;
  readonly sku: string;
  readonly name: string;
  readonly version?: string;
  readonly status?: ProductInfo['status'];
}

export interface ProductAdapter {
  readonly name: string;
  findProduct(tenantId: TenantId, sku: string): ProductInfo | undefined;
  upsertProduct(input: UpsertProductInput): ProductInfo;
  listProducts(tenantId: TenantId): readonly ProductInfo[];
}

function req(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new DomainError('VALIDATION', 'Field must be a non-empty string', { field });
  return value.trim();
}

const PRODUCT_STATUSES: readonly string[] = ['active', 'beta', 'deprecated'];

/** Working in-memory CRM adapter behind the CrmAdapter port: tenant-isolated, keyed by external id, upsert preserves the record id. */
export class InMemoryCrmAdapter implements CrmAdapter {
  private readonly byKey = new Map<string, CrmCustomer>();
  constructor(
    readonly name: string = 'memory-crm',
    private readonly ids: IdGenerator = new SequentialIdGenerator(),
    private readonly clock: Clock = new SystemClock(),
  ) {}
  private key(tenantId: TenantId, externalId: string): string { return tenantId + '|' + externalId.trim(); }
  findCustomer(tenantId: TenantId, externalId: string): CrmCustomer | undefined { return this.byKey.get(this.key(tenantId, externalId)); }
  upsertCustomer(input: UpsertCustomerInput): CrmCustomer {
    const externalId = req(input.externalId, 'externalId');
    const name = req(input.name, 'name');
    if (input.email !== undefined && !input.email.includes('@')) throw new DomainError('VALIDATION', 'Customer email must contain @', { field: 'email' });
    const existing = this.findCustomer(input.tenantId, externalId);
    const record: CrmCustomer = deepFreeze({
      id: existing ? existing.id : (this.ids.next('crm') as CrmRecordId),
      tenantId: input.tenantId, externalId, name,
      email: input.email, company: input.company, tier: input.tier,
      tags: unique(input.tags ?? []), updatedAt: this.clock.now().toISOString(),
    });
    this.byKey.set(this.key(input.tenantId, externalId), record);
    return record;
  }
  listCustomers(tenantId: TenantId): readonly CrmCustomer[] { return [...this.byKey.values()].filter((c) => c.tenantId === tenantId); }
}

/** Working in-memory product adapter behind the ProductAdapter port: tenant-isolated, keyed by SKU, upsert preserves the record id. */
export class InMemoryProductAdapter implements ProductAdapter {
  private readonly byKey = new Map<string, ProductInfo>();
  constructor(
    readonly name: string = 'memory-product',
    private readonly ids: IdGenerator = new SequentialIdGenerator(),
    private readonly clock: Clock = new SystemClock(),
  ) {}
  private key(tenantId: TenantId, sku: string): string { return tenantId + '|' + sku.trim(); }
  findProduct(tenantId: TenantId, sku: string): ProductInfo | undefined { return this.byKey.get(this.key(tenantId, sku)); }
  upsertProduct(input: UpsertProductInput): ProductInfo {
    const sku = req(input.sku, 'sku');
    const name = req(input.name, 'name');
    const status = input.status ?? 'active';
    if (!PRODUCT_STATUSES.includes(status)) throw new DomainError('VALIDATION', 'Unknown product status', { status });
    const existing = this.findProduct(input.tenantId, sku);
    const record: ProductInfo = deepFreeze({
      id: existing ? existing.id : (this.ids.next('prd') as ProductId),
      tenantId: input.tenantId, sku, name, version: input.version, status, updatedAt: this.clock.now().toISOString(),
    });
    this.byKey.set(this.key(input.tenantId, sku), record);
    return record;
  }
  listProducts(tenantId: TenantId): readonly ProductInfo[] { return [...this.byKey.values()].filter((p) => p.tenantId === tenantId); }
}

/** Registry of named integration adapters, mirroring ChannelRegistry: duplicates are a conflict, unknown names are not found. */
export class IntegrationRegistry {
  private readonly crm = new Map<string, CrmAdapter>();
  private readonly product = new Map<string, ProductAdapter>();
  registerCrm(adapter: CrmAdapter): void {
    if (this.crm.has(adapter.name)) throw new DomainError('CONFLICT', 'CRM adapter already registered', { name: adapter.name });
    this.crm.set(adapter.name, adapter);
  }
  registerProduct(adapter: ProductAdapter): void {
    if (this.product.has(adapter.name)) throw new DomainError('CONFLICT', 'Product adapter already registered', { name: adapter.name });
    this.product.set(adapter.name, adapter);
  }
  getCrm(name: string): CrmAdapter {
    const adapter = this.crm.get(name);
    if (!adapter) throw new DomainError('NOT_FOUND', 'CRM adapter not registered', { name });
    return adapter;
  }
  getProduct(name: string): ProductAdapter {
    const adapter = this.product.get(name);
    if (!adapter) throw new DomainError('NOT_FOUND', 'Product adapter not registered', { name });
    return adapter;
  }
  crmNames(): readonly string[] { return [...this.crm.keys()]; }
  productNames(): readonly string[] { return [...this.product.keys()]; }
}

export interface EnrichmentRefs {
  readonly customerExternalId?: string;
  readonly productSku?: string;
}

export interface EnrichedContext {
  readonly customer?: CrmCustomer;
  readonly product?: ProductInfo;
}

/** Resolve the CRM customer and product for a ticket through the adapter ports; a missing record is context, not an error. */
export function enrichContext(crm: CrmAdapter, product: ProductAdapter, tenantId: TenantId, refs: EnrichmentRefs): EnrichedContext {
  return deepFreeze({
    customer: refs.customerExternalId !== undefined ? crm.findCustomer(tenantId, refs.customerExternalId) : undefined,
    product: refs.productSku !== undefined ? product.findProduct(tenantId, refs.productSku) : undefined,
  });
}
