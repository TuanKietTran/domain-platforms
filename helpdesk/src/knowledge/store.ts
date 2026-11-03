import { DomainError } from '../core/errors.js';
import { SystemClock, type Clock } from '../core/clock.js';
import type { ArticleId, IdGenerator, TenantId } from '../core/ids.js';
import { deepFreeze, unique } from '../core/util.js';
import type {
  ArticleStatus,
  ArticleVersion,
  CreateArticleInput,
  KnowledgeArticle,
  ListArticlesFilter,
  UpdateArticleInput,
} from './types.js';

export function normalizeTags(tags: readonly string[]): string[] {
  return unique(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0));
}

/**
 * In-memory knowledge base. Every article carries a full version history;
 * the article record mirrors the current version's title and tags. Tenant
 * scoping is total: an article owned by another tenant is indistinguishable
 * from a missing one (NOT_FOUND), so existence never leaks across tenants.
 */
export class KnowledgeStore {
  private readonly articles = new Map<string, KnowledgeArticle>();
  private readonly versions = new Map<string, ArticleVersion[]>();

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  create(input: CreateArticleInput): KnowledgeArticle {
    const title = input.title.trim();
    if (title.length < 2) throw new DomainError('VALIDATION', 'Article title is too short');
    const body = input.body.trim();
    if (body.length === 0) throw new DomainError('VALIDATION', 'Article body is required');
    const id = this.ids.next('art') as ArticleId;
    const now = this.clock.now().toISOString();
    const tags = normalizeTags(input.tags ?? []);
    const article: KnowledgeArticle = deepFreeze({
      id,
      tenantId: input.tenantId,
      title,
      tags,
      status: 'draft' as ArticleStatus,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    const version: ArticleVersion = deepFreeze({
      articleId: id,
      version: 1,
      title,
      body,
      tags,
      authorId: input.authorId,
      changeNote: input.changeNote,
      createdAt: now,
    });
    this.articles.set(id, article);
    this.versions.set(id, [version]);
    return article;
  }

  get(articleId: ArticleId, tenantId: TenantId): KnowledgeArticle {
    return this.requireArticle(articleId, tenantId);
  }

  list(tenantId: TenantId, filter: ListArticlesFilter = {}): readonly KnowledgeArticle[] {
    const wanted = filter.tags ? normalizeTags(filter.tags) : undefined;
    return [...this.articles.values()]
      .filter(
        (article) =>
          article.tenantId === tenantId &&
          (filter.status === undefined || article.status === filter.status) &&
          (wanted === undefined || wanted.every((tag) => article.tags.includes(tag))),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  update(articleId: ArticleId, tenantId: TenantId, input: UpdateArticleInput): KnowledgeArticle {
    const article = this.requireArticle(articleId, tenantId);
    if (input.title === undefined && input.body === undefined && input.tags === undefined) {
      throw new DomainError('VALIDATION', 'Update requires a title, body or tags change');
    }
    const current = this.getCurrentVersion(articleId, tenantId);
    const title = input.title !== undefined ? input.title.trim() : current.title;
    if (title.length < 2) throw new DomainError('VALIDATION', 'Article title is too short');
    const body = input.body !== undefined ? input.body.trim() : current.body;
    if (body.length === 0) throw new DomainError('VALIDATION', 'Article body is required');
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : [...current.tags];
    const now = this.clock.now().toISOString();
    const version: ArticleVersion = deepFreeze({
      articleId,
      version: article.currentVersion + 1,
      title,
      body,
      tags,
      authorId: input.authorId,
      changeNote: input.changeNote,
      createdAt: now,
    });
    this.versions.get(articleId)?.push(version);
    const updated: KnowledgeArticle = deepFreeze({
      ...article,
      title,
      tags,
      currentVersion: version.version,
      updatedAt: now,
    });
    this.articles.set(articleId, updated);
    return updated;
  }

  publish(articleId: ArticleId, tenantId: TenantId): KnowledgeArticle {
    return this.setStatus(articleId, tenantId, 'published');
  }

  archive(articleId: ArticleId, tenantId: TenantId): KnowledgeArticle {
    return this.setStatus(articleId, tenantId, 'archived');
  }

  getVersion(articleId: ArticleId, tenantId: TenantId, version: number): ArticleVersion {
    this.requireArticle(articleId, tenantId);
    const found = (this.versions.get(articleId) ?? []).find((entry) => entry.version === version);
    if (!found) throw new DomainError('NOT_FOUND', 'Article version not found', { articleId, version });
    return found;
  }

  getCurrentVersion(articleId: ArticleId, tenantId: TenantId): ArticleVersion {
    const article = this.requireArticle(articleId, tenantId);
    return this.getVersion(articleId, tenantId, article.currentVersion);
  }

  listVersions(articleId: ArticleId, tenantId: TenantId): readonly ArticleVersion[] {
    this.requireArticle(articleId, tenantId);
    return [...(this.versions.get(articleId) ?? [])];
  }

  private setStatus(articleId: ArticleId, tenantId: TenantId, status: ArticleStatus): KnowledgeArticle {
    const article = this.requireArticle(articleId, tenantId);
    if (article.status === status) return article;
    const updated: KnowledgeArticle = deepFreeze({ ...article, status, updatedAt: this.clock.now().toISOString() });
    this.articles.set(articleId, updated);
    return updated;
  }

  private requireArticle(articleId: ArticleId, tenantId: TenantId): KnowledgeArticle {
    const article = this.articles.get(articleId);
    if (!article || article.tenantId !== tenantId) {
      throw new DomainError('NOT_FOUND', 'Article not found', { articleId });
    }
    return article;
  }
}

export const InMemoryKnowledgeStore = KnowledgeStore;
