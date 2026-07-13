/**
 * @file services/rag-service/src/brain/gap-detector.ts
 * @module GBrain 与 Hybrid RAG
 * @description 记录检索未覆盖的知识缺口建议。
 * @see 联动关注：Fallback 话术与运营补库。
 */
import { KnowledgeStore } from './knowledge-store.js';
import { rewriteQuery } from '../rag/query-rewrite.js';
export class GapDetector {
    store;
    constructor(store = new KnowledgeStore()) {
        this.store = store;
    }
    async record(input) {
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
