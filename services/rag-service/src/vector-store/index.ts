// @ts-nocheck
/**
 * @file services/rag-service/src/vector-store/index.ts
 * @module RAG Service 兼容层
 * @description 按 VECTOR_STORE 环境变量选择存储实现。
 * @see 联动关注：env.ts 配置项。
 */
import { env } from '../config/env.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { PgVectorStore } from './pg-vector-store.js';
export function createVectorStore() {
    if (env.VECTOR_STORE === 'pgvector' && env.DATABASE_URL)
        return new PgVectorStore();
    return new MemoryVectorStore();
}
