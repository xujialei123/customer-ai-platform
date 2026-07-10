// @ts-nocheck
/**
 * @file services/rag-service/src/providers/embedding.ts
 * @module RAG Service 兼容层
 * @description Embedding Provider（mock/OpenAI 兼容）。
 * @see 联动关注：向量维度与 pgvector。
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
async function retry(task, times = 2) {
    // Embedding 属于确定性外部调用，短暂网络抖动可以重试；最终失败必须中止 ingest，不能保存空向量。
    let lastError;
    for (let attempt = 0; attempt <= times; attempt += 1) {
        try {
            return await task();
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}
export class MockEmbeddingProvider {
    // Mock 只用于离线开发，通过中文双字哈希生成固定维度向量，不代表真实语义检索质量。
    async embedText(text) {
        const vector = Array.from({ length: env.VECTOR_DIM }, () => 0);
        const clean = text.toLowerCase().replace(/\s+/g, '');
        for (let index = 0; index < clean.length; index += 1) {
            const token = clean.slice(index, index + 2) || clean[index];
            const hash = createHash('sha256').update(token, 'utf-8').digest();
            vector[hash.readUInt32BE(0) % env.VECTOR_DIM] += hash[4] % 2 === 0 ? 1 : -1;
        }
        const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
        return norm ? vector.map((item) => item / norm) : vector;
    }
    async embedTexts(texts) {
        return Promise.all(texts.map((text) => this.embedText(text)));
    }
}
export class OpenAICompatibleEmbeddingProvider {
    // OpenAI 兼容层同时适配千问百炼等服务，业务层不依赖具体厂商 SDK。
    async embedText(text) {
        return (await this.embedTexts([text]))[0] ?? [];
    }
    async embedTexts(texts) {
        // 控制并发可以避免批量上传时瞬间触发供应商限流，同时保持返回顺序与 chunk 一致。
        const clippedTexts = texts.map((text) => text.slice(0, 8000));
        const results = [];
        const concurrency = 4;
        for (let start = 0; start < clippedTexts.length; start += concurrency) {
            const batch = clippedTexts.slice(start, start + concurrency);
            const vectors = await Promise.all(batch.map((text) => retry(() => this.requestEmbedding(text))));
            results.push(...vectors);
        }
        return results;
    }
    async requestEmbedding(text) {
        // 每个 chunk 单独请求，失败信息保留 HTTP 状态，方便上传页面显示真实解析错误。
        const response = await fetch(`${env.EMBEDDING_BASE_URL}/embeddings`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${env.EMBEDDING_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: env.EMBEDDING_MODEL,
                input: text,
                // text-embedding-v4 默认返回 1024 维；必须显式对齐 pgvector 表的 VECTOR_DIM。
                dimensions: env.VECTOR_DIM,
                encoding_format: 'float'
            })
        });
        if (!response.ok) {
            throw new Error(`Embedding 请求失败：${response.status} ${await response.text()}`);
        }
        const json = await response.json();
        return json.data?.[0]?.embedding ?? [];
    }
}
export function createEmbeddingProvider() {
    // 只有显式配置 provider 和密钥时才调用外部 API；否则使用 Mock，避免开发环境误产生费用。
    if (env.EMBEDDING_PROVIDER === 'openai-compatible' && env.EMBEDDING_API_KEY) {
        return new OpenAICompatibleEmbeddingProvider();
    }
    return new MockEmbeddingProvider();
}
