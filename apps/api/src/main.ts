// @ts-nocheck
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { env } from './config/env.js';
import { conversationRoutes } from './routes/conversations.js';
import { healthRoutes } from './routes/health.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { orderRoutes } from './routes/orders.js';
import { replyDraftRoutes } from './routes/reply-drafts.js';
import { rpaRoutes } from './routes/rpa.js';
import { wecomWebhookRoutes } from './routes/webhooks.wecom.js';
import { startReplyWorker } from './workers/reply.worker.js';
import { registerRpaExtensionGateway } from './rpa/extension-gateway.js';
const app = Fastify({
    logger: true
});
app.addContentTypeParser(['text/xml', 'application/xml', 'text/plain'], { parseAs: 'string' }, (_request, body, done) => {
    // 企业微信回调是 XML 文本，必须按 UTF-8 字符串接收后再验签/解密。
    done(null, body);
});
await app.register(cors, { origin: true });
await app.register(formbody);
await app.register(healthRoutes);
await app.register(rpaRoutes);
await app.register(wecomWebhookRoutes);
await app.register(knowledgeRoutes);
await app.register(orderRoutes);
await app.register(conversationRoutes);
await app.register(replyDraftRoutes);
// 扩展通过本机 WebSocket 接入普通 Chrome 登录会话，避免由 Playwright 打开平台登录页触发风控。
registerRpaExtensionGateway(app.server, env.API_PORT);
// 统一错误处理，避免 zod / 业务异常直接把服务打崩。
app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const message = error instanceof Error ? error.message : '服务内部错误';
    reply.code(500).send({
        ok: false,
        error: message
    });
});
// MVP 阶段把 Worker 和 API 放在同一进程，方便本地启动。
// 生产环境建议拆成独立 worker 进程。
startReplyWorker();
await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
