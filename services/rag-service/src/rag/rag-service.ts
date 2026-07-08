import { KnowledgeStore } from '../brain/knowledge-store.js';
import { classifyIntent } from './intent-classifier.js';
import { rewriteQuery } from './query-rewrite.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { rerank } from './reranker.js';
import { generateCustomerServiceAnswer } from './answer-generator.js';
import { NO_ANSWER_TEXT, shouldFallback } from './fallback.js';
import { ragRetrievalConfig } from './config.js';
import type { RagSearchRequest, RagSearchResponse } from './types.js';

export class HybridRagService {
  constructor(
    private readonly retriever = new HybridRetriever(),
    private readonly store = new KnowledgeStore()
  ) {}

  async answerWithRag(input: RagSearchRequest): Promise<RagSearchResponse> {
    const intent = classifyIntent(input.query);
    const rewrite = rewriteQuery(input.query);
    const candidates = await this.retriever.retrieve({
      query: input.query,
      rewrittenQueries: rewrite.rewrittenQueries,
      keywords: rewrite.keywords,
      platform: input.platform,
      shopId: input.shopId,
      category: intent.category
    });
    const reranked = await rerank(input.query, candidates);
    const finalCards = reranked.slice(0, ragRetrievalConfig.finalTopK);
    if (shouldFallback(finalCards, intent)) {
      await this.store.recordGap({
        query: input.query,
        category: intent.category,
        reason: finalCards.length ? `最高综合分 ${finalCards[0].score.toFixed(3)} 低于阈值` : '没有召回知识卡片',
        suggestedCardTitle: `${intent.category}：${input.query.slice(0, 30)}`,
        suggestedQuestionVariants: rewrite.rewrittenQueries,
        platform: input.platform,
        shopId: input.shopId
      });
      return {
        answer: NO_ANSWER_TEXT,
        confidence: finalCards[0]?.score ?? 0,
        shouldTransferToHuman: true,
        matchedCards: [],
        intent,
        rewrittenQueries: rewrite.rewrittenQueries
      };
    }
    return {
      answer: await generateCustomerServiceAnswer({ query: input.query, cards: finalCards, intent }),
      confidence: finalCards[0]?.score ?? 0,
      shouldTransferToHuman: false,
      matchedCards: finalCards.map((item) => item.card),
      intent,
      rewrittenQueries: rewrite.rewrittenQueries
    };
  }
}

export async function answerWithRag(input: RagSearchRequest): Promise<RagSearchResponse> {
  return new HybridRagService().answerWithRag(input);
}
