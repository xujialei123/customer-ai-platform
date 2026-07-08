import { KnowledgeStore } from './knowledge-store.js';
import type { KnowledgeCategory, KnowledgePlatform } from './types.js';
import { rewriteQuery } from '../rag/query-rewrite.js';

export class GapDetector {
  constructor(private readonly store = new KnowledgeStore()) {}

  async record(input: { query: string; category: KnowledgeCategory; reason: string; platform?: KnowledgePlatform; shopId?: string }): Promise<void> {
    const rewrite = rewriteQuery(input.query);
    await this.store.recordGap({
      query: input.query,
      category: input.category,
      reason: input.reason,
      suggestedCardTitle: `${input.category}：${input.query.slice(0, 30)}`,
      suggestedQuestionVariants: rewrite.rewrittenQueries,
      platform: input.platform,
      shopId: input.shopId
    });
  }
}
