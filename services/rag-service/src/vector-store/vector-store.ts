// @ts-nocheck
/**
 * @file services/rag-service/src/vector-store/vector-store.ts
 * @module RAG Service 兼容层
 * @description 向量存储抽象接口定义。
 * @see 联动关注：memory 与 pgvector 实现。
 */
export function cosineSimilarity(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] * left[index];
        rightNorm += right[index] * right[index];
    }
    if (!leftNorm || !rightNorm)
        return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
