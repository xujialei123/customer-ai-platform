// @ts-nocheck
import { env } from '../config/env.js';

export class RagService {
    kbCache = { ids: [], expiresAt: 0 };

    /**
     * 从 8787 RAG 服务读取已上传知识库 ID。
     * ReplyWorker 必须复用知识库管理页的持久化数据，不能再查询 API 内部另一张废弃的 knowledge_chunks 表。
     */
    async getKnowledgeBaseIds() {
        if (this.kbCache.expiresAt > Date.now())
            return this.kbCache.ids;
        const response = await fetch(`${env.RAG_SERVICE_URL}/api/kb/list`, {
            headers: { 'x-api-key': env.RAG_API_KEY },
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok)
            throw new Error(`RAG 知识库列表请求失败：HTTP ${response.status}`);
        const body = await response.json();
        const ids = (body.knowledgeBases ?? []).map((item) => item.id).filter(Boolean);
        // 短缓存减少每条客户消息都查询知识库列表，同时允许新上传知识在一分钟内自动生效。
        this.kbCache = { ids, expiresAt: Date.now() + 60000 };
        return ids;
    }

    /**
     * 调用统一 RAG 服务执行 Embedding 和 pgvector 检索。
     * 低于硬阈值的候选不能算作知识证据，否则无关内容也可能被风控误判为可自动发送。
     */
    async search(input) {
        try {
            const kbIds = await this.getKnowledgeBaseIds();
            if (kbIds.length === 0)
                return [];
            const response = await fetch(`${env.RAG_SERVICE_URL}/api/rag/search`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json; charset=utf-8',
                    'x-api-key': env.RAG_API_KEY
                },
                body: JSON.stringify({
                    platform: input.platform ?? 'meituan',
                    shopId: input.shopId,
                    kbIds,
                    query: input.query,
                    topK: input.topK ?? 6
                }),
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok)
                throw new Error(`RAG 检索请求失败：HTTP ${response.status}`);
            const body = await response.json();
            return (body.results ?? [])
                .filter((item) => Number(item.score ?? 0) >= env.RAG_HARD_FLOOR)
                .map((item) => ({
                    id: item.chunkId ?? item.id,
                    content: item.content,
                    metadata: {
                        ...(item.metadata ?? {}),
                        source: item.fileName,
                        page: item.page,
                        kbIds
                    },
                    score: Number(item.score ?? 0)
                }));
        }
        catch (error) {
            // RAG 不可用时安全降级为空结果，ReplyWorker 会生成转人工草稿，绝不能绕过知识库直接编答案。
            console.warn('[RagService] 统一知识库检索失败：', error instanceof Error ? error.message : String(error));
            return [];
        }
    }
}
