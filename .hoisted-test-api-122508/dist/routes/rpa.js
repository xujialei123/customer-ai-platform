// @ts-nocheck
import { z } from 'zod';
import { getAdapter } from '../adapters/index.js';
import { inboundMessageQueue } from '../lib/queue.js';
import { MessageService } from '../services/message.service.js';
import { getRpaSelectorConfig, rpaSelectorSchema, updateRpaSelectorConfig } from '../rpa/selector-config.js';
const rpaInboundSchema = z.object({
    platform: z.enum(['douyin', 'meituan']),
    id: z.string(),
    shopId: z.string(),
    conversationId: z.string(),
    customerId: z.string(),
    customerName: z.string().optional(),
    messageType: z.string().optional(),
    content: z.string(),
    attachments: z.array(z.any()).optional(),
    createdAt: z.string().optional()
});
export async function rpaRoutes(app) {
    const messageService = new MessageService();
    // 读取当前平台的 RPA 页面配置。
    // 后续管理后台会用它展示 URL、消息选择器和默认会话字段。
    app.get('/rpa/config/:platform', async (request, reply) => {
        const { platform } = z.object({
            platform: z.enum(['douyin', 'meituan'])
        }).parse(request.params);
        const config = await getRpaSelectorConfig(platform);
        return reply.send({ ok: true, platform, config });
    });
    // 保存当前平台的 RPA 页面配置。
    // 真实平台页面 DOM 可能频繁变化，所以配置要能通过后台更新，而不是每次都改代码发版。
    app.put('/rpa/config/:platform', async (request, reply) => {
        const { platform } = z.object({
            platform: z.enum(['douyin', 'meituan'])
        }).parse(request.params);
        const body = rpaSelectorSchema.parse(request.body);
        const config = await updateRpaSelectorConfig(platform, body);
        // 配置保存后需要重启对应 watcher，避免正在监听的页面中途切换选择器造成重复抓取。
        return reply.send({
            ok: true,
            platform,
            config,
            restartRequired: true
        });
    });
    // RPA 统一入口：抖音、美团 watcher 提取到新消息后，统一发到这里。
    app.post('/rpa/inbound', async (request, reply) => {
        const body = rpaInboundSchema.parse(request.body);
        const adapter = getAdapter(body.platform);
        const unified = await adapter.parseInbound(body);
        const saved = await messageService.saveInboundMessage(unified);
        if (!saved.duplicated) {
            // 新消息才进入异步回复队列；重复消息只返回成功，避免客户刷新页面导致多次生成草稿。
            await inboundMessageQueue.add('reply', { messageId: saved.message.id });
        }
        return reply.send({ ok: true, duplicated: saved.duplicated });
    });
}
