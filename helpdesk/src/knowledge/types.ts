import type { ArticleId, TenantId, UserId } from '../core/ids.js';

export type ArticleStatus = 'draft' | 'published' | 'archived';

export interface KnowledgeArticle {
  readonly id: ArticleId;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly status: ArticleStatus;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArticleVersion {
  readonly articleId: ArticleId;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly authorId?: UserId;
  readonly changeNote?: string;
  readonly createdAt: string;
}

export interface CreateArticleInput {
  readonly tenantId: TenantId;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly authorId?: UserId;
  readonly changeNote?: string;
}

export interface UpdateArticleInput {
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly authorId?: UserId;
  readonly changeNote?: string;
}

export interface ListArticlesFilter {
  readonly status?: ArticleStatus;
  readonly tags?: readonly string[];
}

export interface KnowledgeCitation {
  readonly articleId: ArticleId;
  readonly version: number;
  readonly title: string;
  readonly snippet: string;
}

export interface RetrievalQuery {
  readonly tenantId: TenantId;
  readonly text: string;
  readonly limit?: number;
  readonly tags?: readonly string[];
}

export interface RetrievalHit {
  readonly articleId: ArticleId;
  readonly version: number;
  readonly title: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly snippet: string;
  readonly citation: KnowledgeCitation;
}
