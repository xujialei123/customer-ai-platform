/**
 * @file services/rag-service/src/brain/prompts/gap-detector.prompt.ts
 * @module GBrain 与 Hybrid RAG
 * @description 知识缺口检测与建议的 LLM Prompt。
 * @see 联动关注：GapDetector 调用。
 */
export const gapDetectorRule = '根据未命中问题建议知识卡片标题和用户可能问法，不得编造答案。';
