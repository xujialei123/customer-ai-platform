// @ts-nocheck
/**
 * @file services/rag-service/src/config/runtime-config.ts
 * @module RAG Service 兼容层
 * @description Embedding 运行时热覆盖（与 API config/model.local.json 对齐）。
 * @see 联动关注：embedding.ts、API model-config、/admin/runtime-config。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');
const localConfigPath = resolve(runtimeRoot, 'config/model.local.json');
/** @type {{ baseUrl: string, apiKey: string, model: string } | null} */
let embeddingOverride = null;
let bootstrapped = false;
function isUsableKey(value) {
    const key = String(value || '').trim();
    return Boolean(key) && !['', 'replace-me', 'your_embedding_key'].includes(key);
}
async function loadFromLocalFile() {
    try {
        const text = await readFile(localConfigPath, 'utf-8');
        if (!text.trim())
            return null;
        const parsed = JSON.parse(text);
        const emb = parsed?.embedding;
        if (!emb)
            return null;
        return {
            baseUrl: String(emb.baseUrl || '').trim().replace(/\/$/, ''),
            apiKey: String(emb.apiKey || '').trim(),
            model: String(emb.model || '').trim()
        };
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        return null;
    }
}
async function ensureBootstrapped() {
    if (bootstrapped)
        return;
    bootstrapped = true;
    if (embeddingOverride)
        return;
    embeddingOverride = await loadFromLocalFile();
}
/** 当前生效的 Embedding 目标。 */
export async function getActiveEmbeddingTarget() {
    await ensureBootstrapped();
    if (embeddingOverride?.baseUrl && embeddingOverride?.apiKey) {
        return {
            baseUrl: embeddingOverride.baseUrl.replace(/\/$/, ''),
            apiKey: embeddingOverride.apiKey,
            model: embeddingOverride.model || env.EMBEDDING_MODEL,
            configured: isUsableKey(embeddingOverride.apiKey)
        };
    }
    return {
        baseUrl: String(env.EMBEDDING_BASE_URL || '').replace(/\/$/, ''),
        apiKey: String(env.EMBEDDING_API_KEY || ''),
        model: String(env.EMBEDDING_MODEL || ''),
        configured: isUsableKey(env.EMBEDDING_API_KEY)
    };
}
/** API 转发来的热更新；立即生效，无需重启 RAG。 */
export function applyEmbeddingRuntimeConfig(patch) {
    const next = {
        baseUrl: String(patch?.baseUrl || '').trim().replace(/\/$/, ''),
        apiKey: String(patch?.apiKey || '').trim(),
        model: String(patch?.model || '').trim()
    };
    if (!next.baseUrl || !next.apiKey || !next.model)
        throw new Error('embedding 需要 baseUrl / apiKey / model');
    embeddingOverride = next;
    process.env.EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.EMBEDDING_BASE_URL = next.baseUrl;
    process.env.EMBEDDING_API_KEY = next.apiKey;
    process.env.EMBEDDING_MODEL = next.model;
    return {
        baseUrl: next.baseUrl,
        model: next.model,
        configured: true
    };
}
