// @ts-nocheck
import { z } from 'zod';
import { env, safeEnvView } from '../config/env.js';
import { RagApplication } from '../services/rag-application.js';
import { repository } from '../services/store.js';
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
function requireApiKey(request) {
    const key = request.headers['x-api-key'] ?? request.headers.authorization?.toString().replace(/^Bearer\s+/i, '');
    if (key !== env.RAG_API_KEY)
        throw new Error('RAG API KEY 不正确');
}
export async function apiRoutes(app) {
    const rag = new RagApplication();
    await rag.bootstrapFromUploads();
    app.get('/health', async () => ({ ok: true, service: 'rag-service' }));
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
