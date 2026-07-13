// @ts-nocheck
/**
 * @file apps/api/src/routes/rpa.ts
 * @module API Adapter 与路由
 * @description RPA inbound/outbound、选择器配置和扩展状态。
 * @see 联动关注：MessageService、Chrome 插件。
 */
import { z } from 'zod';
import { getAdapter } from '../adapters/index.js';
import { enqueueInboundMessage } from '../lib/queue.js';
import { MessageService } from '../services/message.service.js';
import { getRpaSelectorConfig, rpaSelectorSchema, updateRpaSelectorConfig } from '../rpa/selector-config.js';
import { getRpaExtensionStatus, broadcastRpaAllowlistUpdate } from '../rpa/extension-gateway.js';
import { OpenClawClient } from '../services/openclaw.service.js';
import { buildRpaAllowlistStatus, isRpaCustomerAllowed, refreshRpaAllowlistCache } from '../rpa/customer-allowlist.js';
import { updateRpaAllowlistConfig, getRpaAllowlistConfig } from '../rpa/allowlist-config.js';
import { terminalLog } from '../utils/terminal-log.js';
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
const rpaOutboundSchema = rpaInboundSchema.extend({
    aiGenerated: z.boolean().optional().default(false)
});
function deriveDomSelectorsLocally(snapshot) {
    const classNames = new Set(snapshot.nodes.flatMap((node) => Array.isArray(node.classes) ? node.classes : []));
    const required = ['message-cell-container', 'left-message', 'text-message', 'normal-text', 'dzim-chat-input-container', 'dzim-chat-input-send', 'user-center', 'userinfo-name-show'];
    if (!required.every((className) => classNames.has(className)))
        return null;
    // 本地兜底只组合快照中真实存在的稳定 class，不猜测平台接口或动态属性值。
    return {
        messageItemSelector: '.message-cell-container:has(.message-wrapper.left-message)',
        messageTextSelector: '.text-message.normal-text',
        replyInputSelector: '.dzim-chat-input-container[contenteditable="plaintext-only"]',
        sendButtonSelector: '.dzim-chat-input-send > button.dzim-button-primary',
        sessionRootSelector: '.user-center[lx-mv]',
        customerNameSelector: '.userinfo-name-show',
        trackingAttribute: 'lx-mv'
    };
}
export async function rpaRoutes(app) {
    const messageService = new MessageService();
    const openClawClient = new OpenClawClient();
    // 仅返回连接数量和会话标识，不暴露平台 Cookie、账号或页面内容。
    app.get('/rpa/extension/status', async () => ({ ok: true, ...getRpaExtensionStatus(), ...buildRpaAllowlistStatus() }));
    app.get('/rpa/allowlist', async () => {
        const config = await getRpaAllowlistConfig();
        return { ok: true, ...config };
    });
    app.put('/rpa/allowlist', async (request) => {
        const body = z.object({
            meituan: z.array(z.string()).optional(),
            douyin: z.array(z.string()).optional(),
            // 也接受逗号分隔字符串，方便配置页 textarea 直接提交。
            meituanText: z.string().optional(),
            douyinText: z.string().optional()
        }).parse(request.body ?? {});
        const parseText = (text) => String(text || '')
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter(Boolean);
        const saved = await updateRpaAllowlistConfig({
            meituan: Array.isArray(body.meituan) ? body.meituan : (body.meituanText != null ? parseText(body.meituanText) : undefined),
            douyin: Array.isArray(body.douyin) ? body.douyin : (body.douyinText != null ? parseText(body.douyinText) : undefined)
        });
        await refreshRpaAllowlistCache();
        const status = broadcastRpaAllowlistUpdate();
        terminalLog('warn', {
            denyReason: 'allowlist_updated',
            platform: 'meituan',
            content: `美团=${saved.meituan.length ? saved.meituan.join(',') : '全部开放'}；抖音=${saved.douyin.length ? saved.douyin.join(',') : '全部开放'}`
        });
        return { ok: true, ...saved, syncedClients: status };
    });
    app.post('/rpa/extension/analyze-dom', async (request, reply) => {
        const body = z.object({
            snapshot: z.object({
                platform: z.literal('meituan'),
                nodes: z.array(z.any()).max(300),
                counts: z.record(z.number()).optional()
            })
        }).parse(request.body);
        const aiSelectors = await openClawClient.analyzeDomSelectors(body.snapshot);
        const selectors = aiSelectors ?? deriveDomSelectorsLocally(body.snapshot);
        if (!selectors)
            return reply.code(503).send({ ok: false, error: 'OpenClaw 未返回有效的选择器 JSON' });
        return reply.send({ ok: true, selectors, source: aiSelectors ? 'openclaw' : 'local-validated-fallback' });
    });
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
        if (!isRpaCustomerAllowed(body)) {
            // 非白名单美团客户不进入数据库和队列，线上灰度只处理指定测试账号。
            return reply.send({ ok: true, ignored: true, reason: 'customer_not_allowed' });
        }
        const adapter = getAdapter(body.platform);
        const unified = await adapter.parseInbound(body);
        const saved = await messageService.saveInboundMessage(unified);
        if (!saved.duplicated) {
            // 新消息才进入异步回复队列；重复消息只返回成功，避免客户刷新页面导致多次生成草稿。
            await enqueueInboundMessage(saved.message.id);
        }
        terminalLog('inbound', {
            platform: body.platform,
            customer: body.customerName || body.customerId || body.conversationId,
            duplicated: saved.duplicated,
            content: body.content
        });
        return reply.send({ ok: true, duplicated: saved.duplicated });
    });
    // 扩展观察到商家消息真正出现在页面后再入库，避免把“仅回填输入框”的草稿误认为已经发送。
    app.post('/rpa/outbound', async (request, reply) => {
        const body = rpaOutboundSchema.parse(request.body);
        if (!isRpaCustomerAllowed(body)) {
            // 商家手工回复其他客户时不写入本系统，避免白名单测试污染真实会话上下文。
            return reply.send({ ok: true, ignored: true, reason: 'customer_not_allowed' });
        }
        const saved = await messageService.saveOutboundMessage({
            ...body,
            raw: body,
            createdAt: body.createdAt ?? new Date().toISOString()
        });
        if (!saved.duplicated) {
            terminalLog('outbound', {
                platform: body.platform,
                customer: body.customerName || body.customerId || body.conversationId,
                content: body.content
            });
        }
        return reply.send({ ok: true, duplicated: saved.duplicated });
    });
}
