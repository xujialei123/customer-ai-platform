/**
 * @file services/rag-service/src/brain/types.ts
 * @module GBrain 与 Hybrid RAG
 * @description Wiki、KnowledgeCard、Graph、Gap 等 Brain 类型。
 * @see 联动关注：数据库表结构和 API Schema。
 */
export type KnowledgePlatform = 'meituan' | 'douyin' | 'wecom' | 'all';

export type KnowledgeCategory =
  | 'price'
  | 'refund'
  | 'reservation'
  | 'parking'
  | 'address'
  | 'business_hours'
  | 'package'
  | 'service'
  | 'faq'
  | 'other';

export interface ParsedDocument {
  id: string;
  name: string;
  type: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface WikiPage {
  id: string;
  kbId: string;
  title: string;
  summary: string;
  content: string;
  faq: Array<{ question: string; answer: string }>;
  keywords: string[];
  questionVariants: string[];
  relatedTopics: string[];
  sourceIds: string[];
  platform?: KnowledgePlatform;
  shopId?: string;
  category?: KnowledgeCategory;
  updatedAt: string;
  createdAt: string;
}

export interface KnowledgeCard {
  id: string;
  kbId: string;
  wikiPageId?: string;
  title: string;
  content: string;
  answer?: string;
  questionVariants: string[];
  keywords: string[];
  tags: string[];
  platform?: KnowledgePlatform;
  shopId?: string;
  shopName?: string;
  category: KnowledgeCategory;
  relatedCardIds: string[];
  sourceType: 'manual' | 'pdf' | 'word' | 'excel' | 'markdown' | 'web' | 'wiki';
  sourceId?: string;
  sourceName?: string;
  priority: number;
  enabled: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: 'related' | 'depends_on' | 'same_topic' | 'policy_of' | 'package_contains';
}

export interface KnowledgeGap {
  id: string;
  query: string;
  category: KnowledgeCategory;
  reason: string;
  suggestedCardTitle: string;
  suggestedQuestionVariants: string[];
  platform?: KnowledgePlatform;
  shopId?: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}
