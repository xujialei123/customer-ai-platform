// @ts-nocheck
/**
 * @file apps/api/src/services/embedding.service.ts
 * @module API Service 与 Worker
 * @description API 旧知识表 Embedding 兼容实现。
 * @see 联动关注：新检索由 8787 rag-service 负责。
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
export class EmbeddingService {
    // 调用 OpenAI-compatible embedding API。
    // 如果未配置真实 key，则使用本地确定性向量，保证 MVP 本地 RAG 链路可以先跑通。
    async embedText(text) {
        if (this.shouldUseLocalFallback()) {
            return this.embedTextLocally(text);
        }
        const res = await fetch(`${env.EMBEDDING_BASE_URL}/embeddings`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${env.EMBEDDING_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: env.EMBEDDING_MODEL,
                input: text
            })
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Embedding 请求失败：${res.status} ${body}`);
        }
        const json = await res.json();
        return json.data[0].embedding;
    }
    shouldUseLocalFallback() {
        return !env.EMBEDDING_API_KEY || env.EMBEDDING_API_KEY === 'replace-me';
    }
    /**
     * 生成本地确定性向量。
     * 这样没有外部 embedding 服务时，知识库入库和检索仍能做最小可用验证；
     * 生产环境应配置真实 embedding 服务，以获得更好的中文语义召回效果。
     */
    embedTextLocally(text) {
        const dimension = env.EMBEDDING_DIM;
        const vector = Array.from({ length: dimension }, () => 0);
        const clean = text.toLowerCase().replace(/\s+/g, '');
        if (!clean)
            return vector;
        for (let index = 0; index < clean.length; index += 1) {
            const token = clean.slice(index, index + 2) || clean[index];
            const hash = createHash('sha256').update(token).digest();
            const position = hash.readUInt32BE(0) % dimension;
            const sign = hash[4] % 2 === 0 ? 1 : -1;
            vector[position] += sign;
        }
        const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
        if (norm === 0)
            return vector;
        return vector.map((item) => item / norm);
    }
}
