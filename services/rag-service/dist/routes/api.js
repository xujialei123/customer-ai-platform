// @ts-nocheck
/**
 * @file services/rag-service/src/routes/api.ts
 * @module RAG Service 兼容层
 * @description KB CRUD、Wiki 编译、卡片、Graph、Gap、检索和回答 API。
 * @see 联动关注：Brain 模块与 Hybrid RAG。
 */
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { env, safeEnvView } from '../config/env.js';
import { applyEmbeddingRuntimeConfig, getActiveEmbeddingTarget } from '../config/runtime-config.js';
import { RagApplication } from '../services/rag-application.js';
import { repository } from '../services/store.js';
import { BrainSync } from '../brain/brain-sync.js';
import { KnowledgeStore } from '../brain/knowledge-store.js';
import { createEmbeddingProvider } from '../providers/embedding.js';
import { answerWithRag, HybridRagService } from '../rag/rag-service.js';
import { shouldFallback } from '../rag/fallback.js';
const createKbSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional()
});
const searchSchema = z.object({
    platform: z.string(),
    shopId: z.string(),
    kbIds: z.array(z.string()),
    query: z.string().min(1),
    topK: z.number().optional()
});
const chatSchema = z.object({
    platform: z.enum(['douyin', 'meituan', 'wecom']),
    shopId: z.string(),
    sessionId: z.string(),
    externalUserId: z.string().optional(),
    externalUserName: z.string().optional(),
    userMessage: z.string().min(1),
    history: z.array(z.object({ role: z.enum(['user', 'assistant', 'system', 'human']), content: z.string() })).optional()
});
const ragAnswerSchema = z.object({
    query: z.string().min(1),
    platform: z.enum(['douyin', 'meituan', 'wecom']).optional(),
    shopId: z.string().optional(),
    shopName: z.string().optional(),
    userId: z.string().optional()
});
const cardPatchSchema = z.object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    answer: z.string().optional(),
    questionVariants: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    platform: z.enum(['douyin', 'meituan', 'wecom', 'all']).optional(),
    shopId: z.string().nullable().optional(),
    shopName: z.string().nullable().optional(),
    category: z.enum(['price', 'refund', 'reservation', 'parking', 'address', 'business_hours', 'package', 'service', 'faq', 'other']).optional(),
    relatedCardIds: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional()
});
const cardCreateSchema = cardPatchSchema.extend({
    kbId: z.string(),
    title: z.string().min(1),
    content: z.string().min(1),
    category: z.enum(['price', 'refund', 'reservation', 'parking', 'address', 'business_hours', 'package', 'service', 'faq', 'other'])
});
function requireApiKey(request) {
    const key = request.headers['x-api-key'] ?? request.headers.authorization?.toString().replace(/^Bearer\s+/i, '');
    if (key !== env.RAG_API_KEY)
        throw new Error('RAG API KEY 不正确');
}
export async function apiRoutes(app) {
    const rag = new RagApplication();
    const brain = new BrainSync();
    const knowledgeStore = new KnowledgeStore();
    const hybridRag = new HybridRagService();
    await rag.bootstrapFromUploads();
    app.get('/health', async () => ({ ok: true, service: 'rag-service' }));
    // 配置页热更新 Embedding，供 API model-config 转发；需 RAG API Key。
    app.put('/admin/runtime-config', async (request, reply) => {
        requireApiKey(request);
        const body = request.body ?? {};
        if (body.embedding) {
            const applied = applyEmbeddingRuntimeConfig(body.embedding);
            return reply.send({ ok: true, embedding: applied });
        }
        return reply.send({ ok: true, embedding: await getActiveEmbeddingTarget() });
    });
    app.get('/admin/runtime-config', async (request, reply) => {
        requireApiKey(request);
        const embedding = await getActiveEmbeddingTarget();
        return reply.send({
            ok: true,
            embedding: {
                baseUrl: embedding.baseUrl,
                model: embedding.model,
                configured: embedding.configured
            }
        });
    });
    app.get('/api/kb/list', async (request, reply) => {
        requireApiKey(request);
        return reply.send({
            knowledgeBases: [...repository.knowledgeBases.values()].map((kb) => ({
                ...kb,
                fileCount: repository.getFilesByKb(kb.id).length
            }))
        });
    });
    app.post('/api/kb/create', async (request, reply) => {
        requireApiKey(request);
        const body = createKbSchema.parse(request.body);
        const kb = await rag.createKb(body);
        return reply.send({ kbId: kb.id });
    });
    app.post('/api/kb/:kbId/upload', async (request, reply) => {
        requireApiKey(request);
        const { kbId } = z.object({ kbId: z.string() }).parse(request.params);
        const file = await request.file();
        if (!file)
            throw new Error('缺少上传文件');
        const data = await file.toBuffer();
        if (data.byteLength > env.MAX_FILE_SIZE_MB * 1024 * 1024)
            throw new Error('文件超过大小限制');
        const saved = await rag.saveUpload({ kbId, fileName: file.filename, data });
        return reply.send({ fileId: saved.id, status: saved.parseStatus });
    });
    app.post('/api/kb/:kbId/upload-and-ingest', async (request, reply) => {
        requireApiKey(request);
        const { kbId } = z.object({ kbId: z.string() }).parse(request.params);
        const file = await request.file();
        if (!file)
            throw new Error('缺少上传文件');
        const data = await file.toBuffer();
        if (data.byteLength > env.MAX_FILE_SIZE_MB * 1024 * 1024)
            throw new Error('文件超过大小限制');
        const saved = await rag.saveUpload({ kbId, fileName: file.filename, data });
        const ingest = await rag.ingestFile(kbId, saved.id);
        return reply.send({ fileId: saved.id, status: 'completed', chunkCount: ingest.chunkCount });
    });
    app.post('/api/kb/:kbId/files/:fileId/ingest', async (request, reply) => {
        requireApiKey(request);
        const { kbId, fileId } = z.object({ kbId: z.string(), fileId: z.string() }).parse(request.params);
        return reply.send(await rag.ingestFile(kbId, fileId));
    });
    app.post('/api/kb/:kbId/files/:fileId/compile-brain', async (request, reply) => {
        requireApiKey(request);
        const { kbId, fileId } = z.object({ kbId: z.string(), fileId: z.string() }).parse(request.params);
        const options = z.object({ platform: z.enum(['douyin', 'meituan', 'wecom', 'all']).optional(), shopId: z.string().optional() }).parse(request.body ?? {});
        const file = repository.files.get(fileId);
        if (!file || file.kbId !== kbId)
            throw new Error('文件不存在或不属于当前知识库');
        const result = await brain.compileFile({ kbId, fileId, filePath: file.filePath, fileName: file.fileName, ...options });
        return reply.send({ wikiPageId: result.wikiPage.id, cardCount: result.cards.length, edgeCount: result.edges.length });
    });
    app.get('/api/kb/:kbId/files', async (request, reply) => {
        requireApiKey(request);
        const { kbId } = z.object({ kbId: z.string() }).parse(request.params);
        return reply.send({
            files: repository.getFilesByKb(kbId).map((file) => ({
                id: file.id,
                fileName: file.fileName,
                parseStatus: file.parseStatus,
                chunkCount: file.chunkCount,
                errorMessage: file.errorMessage
            }))
        });
    });
    app.delete('/api/kb/:kbId/files/:fileId', async (request, reply) => {
        requireApiKey(request);
        const { kbId, fileId } = z.object({ kbId: z.string(), fileId: z.string() }).parse(request.params);
        await repository.deleteFile(kbId, fileId);
        return reply.send({ ok: true });
    });
    app.post('/api/rag/search', async (request, reply) => {
        requireApiKey(request);
        const body = searchSchema.parse(request.body);
        const results = await rag.search(body);
        return reply.send({ query: body.query, results });
    });
    app.post('/api/rag/chat', async (request, reply) => {
        requireApiKey(request);
        return reply.send(await rag.chat(chatSchema.parse(request.body)));
    });
    app.post('/api/rag/answer', async (request, reply) => {
        requireApiKey(request);
        return reply.send(await answerWithRag(ragAnswerSchema.parse(request.body)));
    });
    app.post('/api/rag/retrieve', async (request, reply) => {
        requireApiKey(request);
        const input = ragAnswerSchema.parse(request.body);
        const result = await hybridRag.retrieve(input);
        const safeResults = shouldFallback(result.finalCards, result.intent) ? [] : result.finalCards;
        return reply.send({
            intent: result.intent,
            rewrittenQueries: result.rewrite.rewrittenQueries,
            results: safeResults.map((item) => ({
                id: item.card.id,
                content: item.card.answer ?? item.card.content,
                title: item.card.title,
                score: item.score,
                metadata: {
                    category: item.card.category,
                    platform: item.card.platform,
                    shopId: item.card.shopId,
                    sourceName: item.card.sourceName
                }
            }))
        });
    });
    app.get('/api/brain/wiki', async (request, reply) => {
        requireApiKey(request);
        const query = z.object({ kbId: z.string().optional() }).parse(request.query);
        return reply.send({ pages: await knowledgeStore.listWikiPages(query.kbId) });
    });
    app.get('/api/brain/cards', async (request, reply) => {
        requireApiKey(request);
        const query = z.object({ platform: z.string().optional(), shopId: z.string().optional(), category: z.string().optional(), limit: z.coerce.number().optional() }).parse(request.query);
        return reply.send({ cards: await knowledgeStore.listCards(query) });
    });
    app.post('/api/brain/cards', async (request, reply) => {
        requireApiKey(request);
        const input = cardCreateSchema.parse(request.body);
        const now = new Date().toISOString();
        const card = {
            id: `card_${nanoid()}`,
            kbId: input.kbId,
            title: input.title,
            content: input.content,
            answer: input.answer || input.content,
            questionVariants: input.questionVariants ?? [],
            keywords: input.keywords ?? [],
            tags: input.tags ?? [input.category],
            platform: input.platform ?? 'all',
            shopId: input.shopId ?? undefined,
            shopName: input.shopName ?? undefined,
            category: input.category,
            relatedCardIds: input.relatedCardIds ?? [],
            sourceType: 'manual',
            priority: input.priority ?? 100,
            enabled: input.enabled ?? true,
            createdAt: now,
            updatedAt: now
        };
        const embedding = await createEmbeddingProvider().embedText([card.title, ...card.questionVariants, card.answer, ...card.keywords].join('\n'));
        await knowledgeStore.saveCards([card], [embedding]);
        return reply.send({ card });
    });
    app.patch('/api/brain/cards/:id', async (request, reply) => {
        requireApiKey(request);
        const { id } = z.object({ id: z.string() }).parse(request.params);
        const patch = cardPatchSchema.parse(request.body);
        const updated = await knowledgeStore.updateCard(id, patch);
        if (!updated)
            return reply.code(404).send({ error: '知识卡片不存在' });
        // 内容修改后必须同步重建向量，否则管理页看到新答案但检索仍使用旧语义。
        const embedding = await createEmbeddingProvider().embedText([updated.title, ...updated.questionVariants, updated.answer ?? updated.content].join('\n'));
        await knowledgeStore.saveCards([updated], [embedding]);
        return reply.send({ card: updated });
    });
    app.get('/api/brain/graph', async (request, reply) => {
        requireApiKey(request);
        return reply.send({ edges: await knowledgeStore.listEdges() });
    });
    app.get('/api/brain/gaps', async (request, reply) => {
        requireApiKey(request);
        return reply.send({ gaps: await knowledgeStore.listGaps() });
    });
    app.get('/api/debug/config', async () => safeEnvView());
    app.get('/api/debug/routes', async () => ({ channels: repository.knowledgeBases.size ? [...repository.knowledgeBases.values()] : [] }));
    app.post('/api/debug/test-chat', async (request, reply) => {
        const body = z.object({ platform: z.enum(['douyin', 'meituan', 'wecom']), shopId: z.string(), message: z.string() }).parse(request.body);
        return reply.send(await rag.chat({
            platform: body.platform,
            shopId: body.shopId,
            sessionId: `${body.platform}_debug`,
            externalUserId: `${body.platform}_debug`,
            userMessage: body.message
        }));
    });
    app.get('/api/debug/logs/retrieval', async () => ({ logs: repository.retrievalLogs.slice(0, 50) }));
}
