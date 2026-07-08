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
