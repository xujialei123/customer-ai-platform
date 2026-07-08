// @ts-nocheck
import { env } from '../config/env.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { PgVectorStore } from './pg-vector-store.js';
export function createVectorStore() {
    if (env.VECTOR_STORE === 'pgvector' && env.DATABASE_URL)
        return new PgVectorStore();
    return new MemoryVectorStore();
}
