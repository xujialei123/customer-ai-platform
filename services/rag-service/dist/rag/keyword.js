/**
 * @file services/rag-service/src/rag/keyword.ts
 * @module GBrain 与 Hybrid RAG
 * @description 中文关键词提取和 BM25 式评分。
 * @see 联动关注：口语化 query 召回补强。
 */
const stopWords = new Set(['请问', '一下', '这个', '那个', '你们', '我们', '可以', '能不能', '是否', '怎么', '怎么样']);
export function normalizeChineseText(text) {
    return text.toLowerCase().replace(/[\s，。！？、,.!?;；:：()（）【】\[\]"'“”‘’]/g, '');
}
export function extractKeywords(text) {
    const normalized = normalizeChineseText(text);
    const words = text.match(/[\p{Script=Han}]{2,8}|[a-zA-Z0-9_-]{2,}/gu) ?? [];
    const bigrams = Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2));
    return [...new Set([...words, ...bigrams].map(normalizeChineseText).filter((item) => item.length >= 2 && !stopWords.has(item)))];
}
export function keywordScore(queryKeywords, cardText) {
    if (queryKeywords.length === 0)
        return 0;
    const normalized = normalizeChineseText(cardText);
    const matched = queryKeywords.filter((keyword) => normalized.includes(normalizeChineseText(keyword)));
    // 使用覆盖率并给完整短语额外加权，解决中文没有空格时 PostgreSQL 分词不稳定的问题。
    const coverage = matched.length / queryKeywords.length;
    const exactBonus = matched.some((keyword) => keyword.length >= 4) ? 0.15 : 0;
    return Math.min(1, coverage + exactBonus);
}
