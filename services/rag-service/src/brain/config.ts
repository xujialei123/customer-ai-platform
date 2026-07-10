/**
 * @file services/rag-service/src/brain/config.ts
 * @module GBrain 与 Hybrid RAG
 * @description 文档长度、卡片数量等 Brain 编译配置。
 * @see 联动关注：编译成本与 LLM 调用次数。
 */
export const brainConfig = {
  maxDocumentChars: 60000,
  maxCardsPerWiki: 80,
  defaultPriority: 100,
  defaultPlatform: 'all' as const
};
