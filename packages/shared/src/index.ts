/**
 * @file packages/shared/src/index.ts
 * @module 数据库、共享包与交付
 * @description 跨包共享类型：Platform、UnifiedMessage、RAG 请求响应等。
 * @see 联动关注：Adapter、API、RPA SDK 共同引用。
 */
export type Platform = 'douyin' | 'meituan' | 'wecom';

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system' | 'human';
  content: string;
}

export interface RagChatRequest {
  platform: Platform;
  shopId: string;
  sessionId: string;
  externalUserId?: string;
  externalUserName?: string;
  userMessage: string;
  history?: ChatHistoryItem[];
}

export interface RagSource {
  fileName: string;
  page?: number;
  score?: number;
}

export interface RagChatResponse {
  answer: string;
  confidence: number;
  shouldReply: boolean;
  needHuman: boolean;
  reason?: string;
  sources?: RagSource[];
}
