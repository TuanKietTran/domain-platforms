import { FakeClock } from '../src/core/clock.ts';
import { AuditLog } from '../src/audit/index.ts';
import { Directory, contextFor, type AccessContext, type Tenant, type User } from '../src/identity/index.ts';
import { VersionStore } from '../src/versioning/index.ts';
import { ContractService } from '../src/lifecycle/index.ts';
import { DocumentService, MemoryBlobStore } from '../src/documents/index.ts';
import { ObligationService } from '../src/obligations/index.ts';
import { ApprovalService } from '../src/risk/index.ts';
import { PlaybookService } from '../src/clauses/playbook.ts';

export interface World {
  clock: FakeClock; audit: AuditLog; directory: Directory;
  tenant: Tenant; otherTenant: Tenant;
  admin: User; counsel: User; contributor: User; viewer: User; outsider: User;
  adminCtx: AccessContext; counselCtx: AccessContext; contributorCtx: AccessContext; viewerCtx: AccessContext; outsiderCtx: AccessContext;
  versions: VersionStore; contracts: ContractService; documents: DocumentService;
  obligations: ObligationService; approvals: ApprovalService;
  playbooks: PlaybookService; gatedContracts: ContractService;
}

export function makeWorld(): World {
  const clock = new FakeClock('2026-01-05T09:00:00.000Z'); // a Monday
  const audit = new AuditLog(clock);
  const directory = new Directory();
  const tenant = directory.createTenant('Acme Legal', 'acme', clock.now().toISOString());
  const otherTenant = directory.createTenant('Other Co', 'other', clock.now().toISOString());
  const admin = directory.createUser(tenant.id, 'admin@acme.test', 'Admin', ['admin']);
  const counsel = directory.createUser(tenant.id, 'counsel@acme.test', 'Counsel', ['counsel']);
  const contributor = directory.createUser(tenant.id, 'dev@acme.test', 'Contributor', ['contributor']);
  const viewer = directory.createUser(tenant.id, 'view@acme.test', 'Viewer', ['viewer']);
  const outsider = directory.createUser(otherTenant.id, 'out@other.test', 'Outsider', ['admin']);
  const versions = new VersionStore(clock);
  const approvals = new ApprovalService({ clock, audit });
  return {
    clock, audit, directory, tenant, otherTenant, admin, counsel, contributor, viewer, outsider,
    adminCtx: contextFor(admin), counselCtx: contextFor(counsel), contributorCtx: contextFor(contributor),
    viewerCtx: contextFor(viewer), outsiderCtx: contextFor(outsider),
    versions,
    contracts: new ContractService({ clock, audit, versions }),
    documents: new DocumentService({ blobs: new MemoryBlobStore(), clock, audit }),
    obligations: new ObligationService({ clock, audit }),
    approvals,
    playbooks: new PlaybookService({ clock, audit }),
    gatedContracts: new ContractService({ clock, audit, versions, approvals }),
  };
}

export const SAMPLE_CONTENT = {
  title: 'Master Services Agreement',
  clauses: [
    { id: 'c1', heading: 'Scope', body: 'Supplier will provide services as described.' },
    { id: 'c2', heading: 'Confidentiality', body: 'Each party will keep the other party\'s confidential information secret.' },
    { id: 'c3', heading: 'Term', body: 'Initial term of 12 months.' },
  ],
};
