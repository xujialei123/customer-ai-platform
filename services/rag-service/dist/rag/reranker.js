/**
 * @file services/rag-service/src/rag/reranker.ts
 * @module GBrain 与 Hybrid RAG
 * @description 可选 LLM 重排候选卡片。
 * @see 联动关注：失败时回退 Hybrid 原始排序。
 */
import { env } from '../config/env.js';
import { createLLMProvider } from '../providers/llm.js';
export async function rerank(query, candidates) {
    if (!env.RAG_USE_RERANK || candidates.length <= 1)
        return candidates;
    try {
        const provider = createLLMProvider();
        const payload = candidates.map((item, index) => ({ index, title: item.card.title, content: item.card.answer ?? item.card.content }));
        const result = await provider.chat({
            platform: 'all',
            prompt: `你是知识相关性重排器。根据问题为每条资料评分，1表示完全能回答，0表示无关。只输出 JSON 数组，例如 [{"index":0,"score":0.9}]。\n问题：${query}\n资料：${JSON.stringify(payload)}`
        });
        const parsed = JSON.parse(result.match(/\[[\s\S]*]/)?.[0] ?? result);
        const scores = new Map(parsed.map((item) => [item.index, Math.max(0, Math.min(1, Number(item.score)))]));
        return candidates.map((item, index) => ({ ...item, rerankScore: scores.get(index) ?? item.hybridScore, score: scores.get(index) ?? item.hybridScore }))
            .sort((left, right) => right.score - left.score);
    }
    catch (error) {
        // 重排属于增强能力，模型超时或 JSON 不合法时必须回退 Hybrid 分数，不能让客服主链路失败。
        console.warn('[Reranker] LLM 重排失败，已回退 Hybrid 分数：', error instanceof Error ? error.message : String(error));
        return candidates;
    }
}
