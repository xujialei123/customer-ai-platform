// @ts-nocheck
import { prisma } from '../lib/prisma.js';
import { EmbeddingService } from './embedding.service.js';
export class RagService {
    embeddingService = new EmbeddingService();
    // 根据客户问题检索门店知识库。
    // 必须按 shopId 过滤，避免 A 门店回答成 B 门店的规则。
    async search(input) {
        const topK = input.topK ?? 6;
        const chunkCount = await prisma.knowledgeChunk.count({
            where: { shopId: input.shopId }
        });
        // 没有知识片段时直接返回空结果，避免无意义调用 embedding 服务。
        // Worker 会据此生成转人工草稿，符合“知识库无答案必须转人工”的规则。
        if (chunkCount === 0)
            return [];
        const embedding = await this.embeddingService.embedText(input.query);
        const vector = `[${embedding.join(',')}]`;
        const rows = await prisma.$queryRawUnsafe(`SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM "knowledge_chunks"
       WHERE "shopId" = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`, vector, input.shopId, topK);
        return rows;
    }
}
