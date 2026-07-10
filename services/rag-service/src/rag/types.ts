/**
 * @file services/rag-service/src/rag/types.ts
 * @module GBrain 与 Hybrid RAG
 * @description Hybrid RAG 请求、响应和候选卡片类型。
 * @see 联动关注：API 路由与 Retriever。
 */
import type { IntentClassifyResult, QueryRewriteResult } from './types-internal.js';
import type { KnowledgeCard, KnowledgeCategory, KnowledgePlatform } from '../brain/types.js';

export type { IntentClassifyResult, QueryRewriteResult } from './types-internal.js';

export interface RagSearchRequest {
  query: string;
  platform?: Exclude<KnowledgePlatform, 'all'>;
  shopId?: string;
  shopName?: string;
  userId?: string;
}

export interface RetrievalCandidate {
  card: KnowledgeCard;
  vectorScore: number;
  keywordScore: number;
  metadataScore: number;
  graphScore: number;
  hybridScore: number;
  rerankScore?: number;
  score: number;
}

export interface RagSearchResponse {
  answer: string;
  confidence: number;
  shouldTransferToHuman: boolean;
  matchedCards: KnowledgeCard[];
  intent: IntentClassifyResult;
  rewrittenQueries: string[];
}

export interface HybridRetrieveInput {
  query: string;
  rewrittenQueries: string[];
  keywords: string[];
  platform?: Exclude<KnowledgePlatform, 'all'>;
  shopId?: string;
  category: KnowledgeCategory;
}
