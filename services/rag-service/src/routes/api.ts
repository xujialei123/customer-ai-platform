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
    category: z.enum(['price','refund','reservation','parking','address','business_hours','package','service','faq','other']).optional(),
    relatedCardIds: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    enabled: z.boolean().optional()
});
const cardCreateSchema = cardPatchSchema.extend({
    kbId: z.string(),
    title: z.string().min(1),
    content: z.string().min(1),
    category: z.enum(['price','refund','reservation','parking','address','business_hours','package','service','faq','other'])
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

    // 存活探针：Docker / 启动脚本确认 8787 进程是否在线。
    app.get('/health', async () => ({ ok: true, service: 'rag-service' }));

    // 热更新 Embedding（baseUrl/model/key）：由 /guide 模型配置页经 API 转发，免重启改向量模型。
    app.put('/admin/runtime-config', async (request, reply) => {
        requireApiKey(request);
        const body = request.body ?? {};
        if (body.embedding) {
            const applied = applyEmbeddingRuntimeConfig(body.embedding);
            return reply.send({ ok: true, embedding: applied });
        }
        return reply.send({ ok: true, embedding: await getActiveEmbeddingTarget() });
    });

    // 读取当前生效的 Embedding 目标（不含密钥），供配置页展示。
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

    // 列出全部知识库及其文件数量，kb-admin 首页用。
    app.get('/api/kb/list', async (request, reply) => {
        requireApiKey(request);
        return reply.send({
            knowledgeBases: [...repository.knowledgeBases.values()].map((kb) => ({
                ...kb,
                fileCount: repository.getFilesByKb(kb.id).length
            }))
        });
    });

    // 新建空知识库容器，后续再往里上传文件。
    app.post('/api/kb/create', async (request, reply) => {
        requireApiKey(request);
        const body = createKbSchema.parse(request.body);
        const kb = await rag.createKb(body);
        return reply.send({ kbId: kb.id });
    });

    // 仅上传并解析文件，不立刻切块入库；适合先确认解析结果再 ingest。
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

    // 上传后立刻走旧版 Chunk ingest，兼容「一次上传即可检索」的旧链路。
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

    // 对已上传文件单独触发 Chunk 切分 + 向量入库（旧 RAG 路径）。
    app.post('/api/kb/:kbId/files/:fileId/ingest', async (request, reply) => {
        requireApiKey(request);
        const { kbId, fileId } = z.object({ kbId: z.string(), fileId: z.string() }).parse(request.params);
        return reply.send(await rag.ingestFile(kbId, fileId));
    });

    // 编译成 LLM Wiki + Knowledge Cards + Graph 边；管理页「编译」按钮主入口，优先于纯 Chunk。
    app.post('/api/kb/:kbId/files/:fileId/compile-brain', async (request, reply) => {
        requireApiKey(request);
        const { kbId, fileId } = z.object({ kbId: z.string(), fileId: z.string() }).parse(request.params);
        const options = z.object({ platform: z.enum(['douyin','meituan','wecom','all']).optional(), shopId: z.string().optional() }).parse(request.body ?? {});
        const file = repository.files.get(fileId);
        if (!file || file.kbId !== kbId)
            throw new Error('文件不存在或不属于当前知识库');
        const result = await brain.compileFile({ kbId, fileId, filePath: file.filePath, fileName: file.fileName, ...options });
        return reply.send({ wikiPageId: result.wikiPage.id, cardCount: result.cards.length, edgeCount: result.edges.length });
    });

    // 列出某知识库下的文件及解析/切块状态。
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

    // 删除知识库内指定文件及其关联产物记录。
    app.delete('/api/kb/:kbId/files/:fileId', async (request, reply) => {
        requireApiKey(request);
        const { kbId, fileId } = z.object({ kbId: z.string(), fileId: z.string() }).parse(request.params);
        await repository.deleteFile(kbId, fileId);
        return reply.send({ ok: true });
    });

    // 旧版按 kbIds 做向量检索，返回 Chunk 命中列表；客服主链路已优先用 Hybrid。
    app.post('/api/rag/search', async (request, reply) => {
        requireApiKey(request);
        const body = searchSchema.parse(request.body);
        const results = await rag.search(body);
        return reply.send({ query: body.query, results });
    });

    // 旧版「检索 + 本地拼答」一体接口，便于联调；正式客服回复由 API 的 ReplyWorker 生成。
    app.post('/api/rag/chat', async (request, reply) => {
        requireApiKey(request);
        return reply.send(await rag.chat(chatSchema.parse(request.body)));
    });

    // Hybrid 检索后在本服务内直接生成回答（调试/独立调用）；客服中台默认走 /api/rag/retrieve。
    app.post('/api/rag/answer', async (request, reply) => {
        requireApiKey(request);
        return reply.send(await answerWithRag(ragAnswerSchema.parse(request.body)));
    });

    // Hybrid 只检索不生成：意图改写 → 卡片召回 → 过滤缺口；供 apps/api RagService 调用。
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

    // 列出编译产生的 Wiki 页面，供审核结构化知识全文。
    app.get('/api/brain/wiki', async (request, reply) => {
        requireApiKey(request);
        const query = z.object({ kbId: z.string().optional() }).parse(request.query);
        return reply.send({ pages: await knowledgeStore.listWikiPages(query.kbId) });
    });

    // 按平台/门店/分类筛选 Knowledge Cards，管理页卡片列表。
    app.get('/api/brain/cards', async (request, reply) => {
        requireApiKey(request);
        const query = z.object({ platform: z.string().optional(), shopId: z.string().optional(), category: z.string().optional(), limit: z.coerce.number().optional() }).parse(request.query);
        return reply.send({ cards: await knowledgeStore.listCards(query) });
    });

    // 手工新建卡片并写入向量，绕过文件编译，适合补高频 FAQ。
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

    // 修改卡片字段；内容变更后重建向量，保证检索与管理页一致。
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

    // 列出卡片之间的关系边（Graph），用于关联推荐与可视化。
    app.get('/api/brain/graph', async (request, reply) => {
        requireApiKey(request);
        return reply.send({ edges: await knowledgeStore.listEdges() });
    });

    // 列出检索/编译发现的知识缺口，便于补资料而不是让模型瞎答。
    app.get('/api/brain/gaps', async (request, reply) => {
        requireApiKey(request);
        return reply.send({ gaps: await knowledgeStore.listGaps() });
    });

    // 调试：返回脱敏后的环境配置视图（不含密钥明文策略见 safeEnvView）。
    app.get('/api/debug/config', async () => safeEnvView());

    // 调试：粗看当前已加载知识库通道。
    app.get('/api/debug/routes', async () => ({ channels: repository.knowledgeBases.size ? [...repository.knowledgeBases.values()] : [] }));

    // 调试：不要求 API Key 的简化聊天探活（勿对公网暴露）。
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

    // 调试：最近若干条检索日志，排查 Hybrid/Chunk 命中情况。
    app.get('/api/debug/logs/retrieval', async () => ({ logs: repository.retrievalLogs.slice(0, 50) }));
}
