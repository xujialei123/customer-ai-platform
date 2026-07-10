/**
 * @file services/rag-service/src/rag/fallback.ts
 * @module GBrain 与 Hybrid RAG
 * @description 低置信度和无答案时的固定话术。
 * @see 联动关注：Gap 记录与 AnswerGenerator。
 */
import type { IntentClassifyResult, RetrievalCandidate } from './types.js';
import { ragRetrievalConfig } from './config.js';

export const NO_ANSWER_TEXT = '当前资料里没有查到明确说明，建议帮您转人工确认一下。';

export function shouldFallback(results: RetrievalCandidate[], intent: IntentClassifyResult): boolean {
  const topScore = results[0]?.score ?? 0;
  if (!results.length || topScore < ragRetrievalConfig.scoreThreshold)
    return true;
  return intent.needStrictAnswer && topScore < ragRetrievalConfig.strictScoreThreshold;
}
