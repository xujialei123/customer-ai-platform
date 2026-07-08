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
