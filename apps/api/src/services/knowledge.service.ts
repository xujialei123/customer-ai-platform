// @ts-nocheck
/**
 * @file apps/api/src/services/knowledge.service.ts
 * @module API Service 与 Worker
 * @description 旧知识片段写入和向量搜索。
 * @see 联动关注：避免与 rag-service 再次分叉。
 */
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma.js';
import { chunkText } from '../utils/chunk-text.js';
import { EmbeddingService } from './embedding.service.js';
export class KnowledgeService {
    embeddingService = new EmbeddingService();
    // 创建知识源并切分入库。
    // 注意：所有文本均按 UTF-8 处理，避免 Windows 中文乱码。
    async createSource(input) {
        await prisma.shop.upsert({
            where: { id: input.shopId },
            update: {},
            create: { id: input.shopId, name: input.shopId }
        });
        const source = await prisma.knowledgeSource.create({
            data: {
                id: nanoid(),
                shopId: input.shopId,
                title: input.title,
                sourceType: input.sourceType,
                content: input.content
            }
        });
        const chunks = chunkText(input.content);
        for (const content of chunks) {
            const embedding = await this.embeddingService.embedText(content);
            const vector = `[${embedding.join(',')}]`;
            // Prisma 对 pgvector 支持有限，这里使用原生 SQL 插入 embedding。
            await prisma.$executeRawUnsafe(`INSERT INTO "knowledge_chunks" ("id", "sourceId", "shopId", "content", "metadata", "embedding") VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)`, nanoid(), source.id, input.shopId, content, JSON.stringify(input.metadata ?? {}), vector);
        }
        return source;
    }
}
