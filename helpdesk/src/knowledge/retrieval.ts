import { round, unique } from '../core/util.js';
import type { KnowledgeStore } from './store.js';
import type { RetrievalHit, RetrievalQuery } from './types.js';

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function makeSnippet(body: string, terms: readonly string[]): string {
  const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
  const hit = sentences.find((sentence) => {
    const tokens = new Set(tokenize(sentence));
    return terms.some((term) => tokens.has(term));
  });
  const chosen = hit ?? sentences[0] ?? body.trim();
  return chosen.length > 200 ? chosen.slice(0, 197).trimEnd() + '...' : chosen;
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const BODY_WEIGHT = 1;

interface IndexedDoc {
  readonly articleId: RetrievalHit['articleId'];
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly counts: ReadonlyMap<string, number>;
  readonly length: number;
}

/**
 * Deterministic BM25-style retrieval over the current version of published
 * articles in one tenant. Title terms weigh 3x, tag terms 2x, body terms 1x.
 * Ranking is score desc, then articleId asc, so identical corpora always
 * produce identical orderings. Every hit carries a citation (article id,
 * version, title, snippet) pointing at the exact text that matched.
 */
export class KnowledgeRetriever {
  constructor(private readonly store: KnowledgeStore) {}

  search(query: RetrievalQuery): readonly RetrievalHit[] {
    const limit = Math.max(0, Math.floor(query.limit ?? 5));
    if (limit === 0) return [];
    const terms = unique(tokenize(query.text));
    if (terms.length === 0) return [];
    const articles = this.store.list(query.tenantId, { status: 'published', tags: query.tags });
    if (articles.length === 0) return [];
    const docs: IndexedDoc[] = articles.map((article) => {
      const version = this.store.getCurrentVersion(article.id, query.tenantId);
      const counts = new Map<string, number>();
      const add = (text: string, weight: number) => {
        for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + weight);
      };
      add(version.title, TITLE_WEIGHT);
      for (const tag of version.tags) add(tag, TAG_WEIGHT);
      add(version.body, BODY_WEIGHT);
      let length = 0;
      for (const count of counts.values()) length += count;
      return { articleId: article.id, version: version.version, title: version.title, body: version.body, counts, length };
    });
    const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
    const hits: RetrievalHit[] = [];
    for (const doc of docs) {
      let score = 0;
      const matchedTerms: string[] = [];
      for (const term of terms) {
        const tf = doc.counts.get(term);
        if (!tf) continue;
        matchedTerms.push(term);
        const df = docs.filter((other) => other.counts.has(term)).length;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * doc.length) / avgLength));
      }
      if (score <= 0 || matchedTerms.length === 0) continue;
      const snippet = makeSnippet(doc.body, terms);
      hits.push({
        articleId: doc.articleId,
        version: doc.version,
        title: doc.title,
        score: round(score, 6),
        matchedTerms,
        snippet,
        citation: { articleId: doc.articleId, version: doc.version, title: doc.title, snippet },
      });
    }
    hits.sort((a, b) => b.score - a.score || (a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0));
    return hits.slice(0, limit);
  }
}

export function searchKnowledge(store: KnowledgeStore, query: RetrievalQuery): readonly RetrievalHit[] {
  return new KnowledgeRetriever(store).search(query);
}
