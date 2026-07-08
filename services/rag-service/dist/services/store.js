// @ts-nocheck
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');
export class RagMemoryRepository {
    // Map 是运行时缓存，便于低延迟读取；启用 pgvector 时 PostgreSQL 才是元数据事实源。
    knowledgeBases = new Map();
    files = new Map();
    chunks = new Map();
    sessions = new Map();
    messages = [];
    retrievalLogs = [];
    dedupe = new Map();
    getFilesByKb(kbId) {
        return [...this.files.values()].filter((file) => file.kbId === kbId);
    }
    getChunksByKbIds(kbIds) {
        const allowed = new Set(kbIds);
        return [...this.chunks.values()].filter((chunk) => allowed.has(chunk.kbId));
    }
    async deleteFile(kbId, fileId) {
        // 删除文件必须同步清理缓存、数据库元数据、向量和磁盘原文件，避免出现幽灵记录。
        const file = this.files.get(fileId);
        if (!file || file.kbId !== kbId)
            throw new Error('文件不存在或不属于当前知识库');
        this.files.delete(fileId);
        for (const chunk of [...this.chunks.values()]) {
            if (chunk.fileId === fileId)
                this.chunks.delete(chunk.id);
        }
        await knowledgePersistence.deleteFile(fileId);
        await rm(file.filePath, { force: true });
    }
    upsertSession(input) {
        // RAG 会话按平台、门店和外部客户隔离，不能只用昵称或页面标题作为会话键。
        const id = `${input.platform}:${input.shopId}:${input.externalUserId}`;
        const now = new Date().toISOString();
        const existed = this.sessions.get(id);
        const session = {
            id,
            platform: input.platform,
            shopId: input.shopId,
            externalUserId: input.externalUserId,
            externalUserName: input.externalUserName,
            aiReplyCount: existed?.aiReplyCount ?? 0,
            needHuman: existed?.needHuman ?? false,
            createdAt: existed?.createdAt ?? now,
            updatedAt: now,
            lastMessageAt: now
        };
        this.sessions.set(id, session);
        return session;
    }
}
export const repository = new RagMemoryRepository();
class KnowledgePersistence {
    enabled = env.VECTOR_STORE === 'pgvector' && Boolean(env.DATABASE_URL);
    pool = this.enabled ? new pg.Pool({ connectionString: env.DATABASE_URL }) : null;
    /**
     * RAG 服务启动时主动建表并恢复元数据，避免 Docker 卷已存在时初始化脚本不再自动执行。
     * 内存 Map 继续作为运行时缓存，PostgreSQL 才是知识库和文件状态的持久化事实源。
     */
    async initialize() {
        if (!this.pool)
            return;
        const schemaPath = resolve(runtimeRoot, 'scripts/init-db.sql');
        const schema = await readFile(schemaPath, 'utf-8');
        const client = await this.pool.connect();
        try {
            // 多个 watcher 意外并发启动时串行执行 DDL，避免 IF NOT EXISTS 仍在系统表层发生竞态。
            await client.query('SELECT pg_advisory_lock($1)', [84321001]);
            await client.query(schema);
        }
        finally {
            await client.query('SELECT pg_advisory_unlock($1)', [84321001]).catch(() => undefined);
            client.release();
        }
        const [kbResult, fileResult] = await Promise.all([
            this.pool.query(`SELECT id, name, description, created_at, updated_at FROM rag_knowledge_bases ORDER BY created_at`),
            this.pool.query(`SELECT id, kb_id, file_name, file_type, file_path, file_hash, parse_status,
                              chunk_count, error_message, created_at, updated_at
                       FROM rag_knowledge_files ORDER BY created_at`)
        ]);
        for (const row of kbResult.rows) {
            repository.knowledgeBases.set(row.id, {
                id: row.id,
                name: row.name,
                description: row.description ?? undefined,
                createdAt: row.created_at.toISOString(),
                updatedAt: row.updated_at.toISOString()
            });
        }
        for (const row of fileResult.rows) {
            repository.files.set(row.id, {
                id: row.id,
                kbId: row.kb_id,
                fileName: row.file_name,
                fileType: row.file_type,
                filePath: row.file_path,
                fileHash: row.file_hash,
                parseStatus: row.parse_status,
                chunkCount: row.chunk_count,
                errorMessage: row.error_message ?? undefined,
                createdAt: row.created_at.toISOString(),
                updatedAt: row.updated_at.toISOString()
            });
        }
    }
    async saveKnowledgeBase(kb) {
        // 使用 upsert 保证服务恢复和重复保存幂等，不因进程重启创建重复知识库。
        if (!this.pool)
            return;
        await this.pool.query(`INSERT INTO rag_knowledge_bases (id, name, description, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, updated_at=EXCLUDED.updated_at`, [kb.id, kb.name, kb.description ?? null, kb.createdAt, kb.updatedAt]);
    }
    async saveFile(file) {
        // 文件状态持续写库，管理页可在解析失败或服务重启后继续展示真实进度。
        if (!this.pool)
            return;
        await this.pool.query(`INSERT INTO rag_knowledge_files
       (id, kb_id, file_name, file_type, file_path, file_hash, parse_status, chunk_count, error_message, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET parse_status=EXCLUDED.parse_status, chunk_count=EXCLUDED.chunk_count,
         error_message=EXCLUDED.error_message, updated_at=EXCLUDED.updated_at`, [file.id, file.kbId, file.fileName, file.fileType, file.filePath, file.fileHash, file.parseStatus,
            file.chunkCount, file.errorMessage ?? null, file.createdAt, file.updatedAt]);
    }
    async deleteFile(fileId) {
        if (!this.pool)
            return;
        await this.pool.query('DELETE FROM rag_knowledge_files WHERE id = $1', [fileId]);
    }
}
export const knowledgePersistence = new KnowledgePersistence();
