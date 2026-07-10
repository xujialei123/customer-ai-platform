// @ts-nocheck
/**
 * @file services/rag-service/src/vector-store/pg-vector-store.ts
 * @module RAG Service 兼容层
 * @description Chunk 级 pgvector 写入和相似度检索。
 * @see 联动关注：向量维度与 HNSW 索引。
 */
import pg from 'pg';
import { env } from '../config/env.js';
export class PgVectorStore {
    pool = new pg.Pool({ connectionString: env.DATABASE_URL });
    async upsertChunks(chunks) {
        // 向量写入必须与数据库 vector 维度一致；维度错误应直接失败，不能静默截断。
        for (const chunk of chunks) {
            const vector = `[${(chunk.embedding ?? []).join(',')}]`;
            // pgvector 只能通过 SQL 字面量或参数转型写入，这里集中封装，避免业务层关心数据库细节。
            await this.pool.query(`INSERT INTO rag_knowledge_chunks (id, kb_id, file_id, content, page, chunk_index, metadata, embedding, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::vector,NOW())
         ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`, [chunk.id, chunk.kbId, chunk.fileId, chunk.content, chunk.page ?? null, chunk.chunkIndex, JSON.stringify(chunk.metadata), vector]);
        }
    }
    async search(input) {
        // pgvector 使用余弦距离召回 TopK；分数仅用于排序和证据筛选，不代表答案正确概率。
        const vector = `[${input.queryEmbedding.join(',')}]`;
        const result = await this.pool.query(`SELECT c.id AS "chunkId", c.content, 1 - (c.embedding <=> $1::vector) AS score,
              c.file_id AS "fileId", f.file_name AS "fileName", c.page, c.metadata
       FROM rag_knowledge_chunks c
       LEFT JOIN rag_knowledge_files f ON f.id = c.file_id
       WHERE c.kb_id = ANY($2)
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`, [vector, input.kbIds, input.topK]);
        return result.rows;
    }
    async deleteByFileId(fileId) {
        // 重新解析或删除文件时必须清理旧向量，否则同一内容会重复召回并污染评分。
        await this.pool.query('DELETE FROM rag_knowledge_chunks WHERE file_id = $1', [fileId]);
    }
}
