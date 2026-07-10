/**
 * @file services/rag-service/src/rag/hybrid-retriever.ts
 * @module GBrain 与 Hybrid RAG
 * @description 融合向量、关键词、Metadata 和 Graph 的混合检索。
 * @see 联动关注：KnowledgeStore 和 Reranker。
 */
import { KnowledgeStore } from '../brain/knowledge-store.js';
import type { KnowledgeCard } from '../brain/types.js';
import { createEmbeddingProvider } from '../providers/embedding.js';
import { ragRetrievalConfig } from './config.js';
import { extractKeywords, keywordScore } from './keyword.js';
import type { HybridRetrieveInput, RetrievalCandidate } from './types.js';

function metadataScore(card: KnowledgeCard, input: HybridRetrieveInput): number {
  let score = 0;
  if (!input.platform || !card.platform || card.platform === 'all' || card.platform === input.platform)
    score += 0.4;
  if (!input.shopId || !card.shopId || card.shopId === input.shopId)
    score += 0.4;
  if (card.category === input.category || card.category === 'other')
    score += 0.2;
  return score;
}

export class HybridRetriever {
  constructor(
    private readonly store = new KnowledgeStore(),
    private readonly embeddingProvider = createEmbeddingProvider()
  ) {}

  async retrieve(input: HybridRetrieveInput): Promise<RetrievalCandidate[]> {
    const queryTexts = [...new Set([input.query, ...input.rewrittenQueries])];
    const embeddings = await this.embeddingProvider.embedTexts(queryTexts);
    const merged = new Map<string, RetrievalCandidate>();
    for (const embedding of embeddings) {
      const vectorHits = await this.store.vectorSearch(embedding, {
        platform: input.platform,
        shopId: input.shopId,
        // 多意图问题可能同时需要套餐与退款卡片，分类只参与加权，不能在召回阶段硬排除。
        category: undefined,
        limit: ragRetrievalConfig.vectorTopK
      });
      for (const hit of vectorHits) {
        const existed = merged.get(hit.card.id);
        if (!existed || hit.score > existed.vectorScore) {
          merged.set(hit.card.id, {
            card: hit.card,
            vectorScore: Math.max(0, hit.score),
            keywordScore: 0,
            metadataScore: metadataScore(hit.card, input),
            graphScore: 0,
            hybridScore: 0,
            score: 0
          });
        }
      }
    }

    // 关键词召回独立于向量召回，口语别名或精确套餐名即使 Embedding 偏低也能进入候选集。
    const keywordCards = await this.store.listCards({
      platform: input.platform,
      shopId: input.shopId,
      category: undefined,
      limit: 500
    });
    const originalKeywords = extractKeywords(input.query);
    for (const card of keywordCards) {
      const score = keywordScore(input.keywords, [card.title, card.answer, card.content, ...card.questionVariants, ...card.keywords].filter(Boolean).join(' '));
      const titleMatched = originalKeywords.some((keyword) => card.title.includes(keyword));
      const adjustedScore = titleMatched ? 1 : score;
      if (adjustedScore <= 0)
        continue;
      const candidate = merged.get(card.id) ?? {
        card,
        vectorScore: 0,
        keywordScore: 0,
        metadataScore: metadataScore(card, input),
        graphScore: 0,
        hybridScore: 0,
        score: 0
      };
      candidate.keywordScore = Math.max(candidate.keywordScore, adjustedScore);
      merged.set(card.id, candidate);
    }

    const preliminary = [...merged.values()].sort((a, b) => (b.vectorScore + b.keywordScore) - (a.vectorScore + a.keywordScore));
    const relatedIds = await this.store.relatedCardIds(preliminary.slice(0, ragRetrievalConfig.graphExpandTopK).map((item) => item.card.id), ragRetrievalConfig.graphExpandTopK);
    for (const id of relatedIds) {
      const candidate = merged.get(id);
      if (candidate)
        candidate.graphScore = 1;
    }

    for (const candidate of merged.values()) {
      candidate.hybridScore = candidate.vectorScore * ragRetrievalConfig.weights.vector
        + candidate.keywordScore * ragRetrievalConfig.weights.keyword
        + candidate.metadataScore * ragRetrievalConfig.weights.metadata
        + candidate.graphScore * ragRetrievalConfig.weights.graph;
      candidate.score = Math.min(1, candidate.hybridScore);
      // 用户原词直接命中卡片标题且门店/平台匹配时，词法证据足够强，不应被较长正文的向量分稀释。
      if (candidate.keywordScore === 1 && candidate.metadataScore === 1)
        candidate.score = Math.max(candidate.score, 0.8);
      if (candidate.card.category === input.category && candidate.vectorScore >= 0.68 && candidate.keywordScore >= 0.25)
        candidate.score = Math.max(candidate.score, 0.76);
    }
    return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, ragRetrievalConfig.rerankTopK);
  }
}
