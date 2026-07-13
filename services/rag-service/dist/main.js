// @ts-nocheck
/**
 * @file services/rag-service/src/main.ts
 * @module RAG Service 兼容层
 * @description 启动 8787 端口 Fastify RAG 服务。
 * @see 联动关注：routes/api.ts 和 admin-page.ts。
 */
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { adminPageRoutes } from './routes/admin-page.js';
import { apiRoutes } from './routes/api.js';
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart, {
    limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 }
});
await app.register(adminPageRoutes);
await app.register(apiRoutes);
app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({
        ok: false,
        error: error instanceof Error ? error.message : '服务内部错误'
    });
});
await app.listen({ port: env.RAG_SERVICE_PORT, host: '0.0.0.0' });
