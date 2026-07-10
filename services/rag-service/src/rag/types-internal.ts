/**
 * @file services/rag-service/src/rag/types-internal.ts
 * @module GBrain 与 Hybrid RAG
 * @description Query Rewrite 和 Intent 分类内部类型。
 * @see 联动关注：rag/types.ts 上层封装。
 */
import type { KnowledgeCategory } from '../brain/types.js';

export interface QueryRewriteResult {
  originalQuery: string;
  rewrittenQueries: string[];
  keywords: string[];
}

export interface IntentClassifyResult {
  category: KnowledgeCategory;
  confidence: number;
  needStrictAnswer: boolean;
}
