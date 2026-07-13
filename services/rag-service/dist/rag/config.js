/**
 * @file services/rag-service/src/rag/config.ts
 * @module GBrain 与 Hybrid RAG
 * @description TopK、相似度阈值和四类检索融合权重。
 * @see 联动关注：调参时需同步回归测试。
 */
export const ragRetrievalConfig = {
    vectorTopK: 30,
    keywordTopK: 20,
    graphExpandTopK: 5,
    rerankTopK: 8,
    finalTopK: 3,
    scoreThreshold: 0.68,
    strictScoreThreshold: 0.75,
    weights: {
        vector: 0.45,
        keyword: 0.25,
        metadata: 0.2,
        graph: 0.1
    }
};
