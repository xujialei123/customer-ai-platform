import { KnowledgeStore } from '../brain/knowledge-store.js';
import { classifyIntent } from './intent-classifier.js';
import { rewriteQuery } from './query-rewrite.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { rerank } from './reranker.js';
import { generateCustomerServiceAnswer } from './answer-generator.js';
import { NO_ANSWER_TEXT, shouldFallback } from './fallback.js';
import { ragRetrievalConfig } from './config.js';
import type { RagSearchRequest, RagSearchResponse } from './types.js';

const highRiskKeywords = ['退款', '退券', '退钱', '能退', '想退', '投诉', '差评', '赔偿', '食品安全', '吃坏', '过敏', '报警', '12315', '工商', '法律', '律师'];

function selectDiverseCandidates(candidates: Awaited<ReturnType<HybridRetriever['retrieve']>>) {
  const selected: typeof candidates = [];
  const signatures = new Set<string>();
  const categoryCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const signature = `${candidate.card.title.replace(/^问[:：]?/, '')}:${(candidate.card.answer ?? candidate.card.content).slice(0, 80)}`;
    if (signatures.has(signature) || (categoryCounts.get(candidate.card.category) ?? 0) >= 2)
      continue;
    signatures.add(signature);
    categoryCounts.set(candidate.card.category, (categoryCounts.get(candidate.card.category) ?? 0) + 1);
    selected.push(candidate);
    if (selected.length >= ragRetrievalConfig.finalTopK)
      break;
  }
  return selected;
}

export class HybridRagService {
  constructor(
    private readonly retriever = new HybridRetriever(),
    private readonly store = new KnowledgeStore()
  ) {}

  async retrieve(input: RagSearchRequest) {
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
    const finalCards = selectDiverseCandidates(reranked);
    return { intent, rewrite, finalCards };
  }

  async answerWithRag(input: RagSearchRequest): Promise<RagSearchResponse> {
    const { intent, rewrite, finalCards } = await this.retrieve(input);
    if (intent.category === 'refund' || highRiskKeywords.some((keyword) => input.query.includes(keyword))) {
      return {
        answer: '这个我帮您转人工确认一下。',
        confidence: finalCards[0]?.score ?? 0,
        shouldTransferToHuman: true,
        matchedCards: finalCards.map((item) => item.card),
        intent,
        rewrittenQueries: rewrite.rewrittenQueries
      };
    }
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
