// @ts-nocheck
/**
 * @file apps/api/src/routes/knowledge.ts
 * @module API Adapter 与路由
 * @description 旧知识库接口兼容层。
 * @see 联动关注：新知识优先走 8787 rag-service。
 */
import { z } from 'zod';
import { KnowledgeService } from '../services/knowledge.service.js';
import { RagService } from '../services/rag.service.js';
const createSourceSchema = z.object({
    shopId: z.string(),
    title: z.string(),
    sourceType: z.string().default('manual'),
    content: z.string().min(1),
    metadata: z.record(z.any()).optional()
});
const searchSchema = z.object({
    shopId: z.string(),
    query: z.string().min(1),
    topK: z.number().optional()
});
export async function knowledgeRoutes(app) {
    const knowledgeService = new KnowledgeService();
    const ragService = new RagService();
    app.post('/knowledge/sources', async (request, reply) => {
        const body = createSourceSchema.parse(request.body);
        const source = await knowledgeService.createSource(body);
        return reply.send({ ok: true, source });
    });
    app.post('/knowledge/search', async (request, reply) => {
        const body = searchSchema.parse(request.body);
        const hits = await ragService.search(body);
        return reply.send({ ok: true, hits });
    });
}
