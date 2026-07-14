// @ts-nocheck
/**
 * @file services/rag-service/src/providers/embedding.ts
 * @module RAG Service 兼容层
 * @description Embedding Provider（mock/OpenAI 兼容）；支持配置页热切换。
 * @see 联动关注：向量维度与 pgvector、runtime-config。
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { getActiveEmbeddingTarget } from '../config/runtime-config.js';
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
    // OpenAI 兼容层同时适配千问百炼等服务；每次请求读热配置，便于配置页切换。
    async embedText(text) {
        return (await this.embedTexts([text]))[0] ?? [];
    }
    async embedTexts(texts) {
        const clippedTexts = texts.map((text) => text.slice(0, 8000));
        if (clippedTexts.length === 0)
            return [];
        if (clippedTexts.length <= 8)
            return retry(() => this.requestEmbeddings(clippedTexts));
        const results = [];
        for (let start = 0; start < clippedTexts.length; start += 8) {
            results.push(...await retry(() => this.requestEmbeddings(clippedTexts.slice(start, start + 8))));
        }
        return results;
    }
    async requestEmbeddings(texts) {
        const target = await getActiveEmbeddingTarget();
        const response = await fetch(`${target.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${target.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: target.model,
                input: texts.length === 1 ? texts[0] : texts,
                // text-embedding-v4 默认返回 1024 维；必须显式对齐 pgvector 表的 VECTOR_DIM。
                dimensions: env.VECTOR_DIM,
                encoding_format: 'float'
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
            throw new Error(`Embedding 请求失败：${response.status} ${await response.text()}`);
        }
        const json = await response.json();
        const rows = Array.isArray(json.data) ? [...json.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0)) : [];
        return texts.map((_, index) => rows[index]?.embedding ?? []);
    }
}
/**
 * 返回按次解析的代理：已缓存的 HybridRetriever 实例也会随配置页切换生效。
 */
export function createEmbeddingProvider() {
    const mock = new MockEmbeddingProvider();
    const remote = new OpenAICompatibleEmbeddingProvider();
    return {
        async embedText(text) {
            const target = await getActiveEmbeddingTarget();
            if (target.configured)
                return remote.embedText(text);
            return mock.embedText(text);
        },
        async embedTexts(texts) {
            const target = await getActiveEmbeddingTarget();
            if (target.configured)
                return remote.embedTexts(texts);
            return mock.embedTexts(texts);
        }
    };
}
