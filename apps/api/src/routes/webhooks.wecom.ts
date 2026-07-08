// @ts-nocheck
import { env } from '../config/env.js';
import { getAdapter } from '../adapters/index.js';
import { inboundMessageQueue } from '../lib/queue.js';
import { MessageService } from '../services/message.service.js';
import { decryptWeComMessage, parseWeComXml, verifyWeComUrl } from '../services/wecom-crypto.service.js';
import { WeComClient } from '../services/wecom-client.service.js';
let kfCursor = '';
const wecomCallbackPaths = ['/webhooks/wecom/customer-service', '/wecom/kf/callback'];
export async function wecomWebhookRoutes(app) {
    const messageService = new MessageService();
    const adapter = getAdapter('wecom');
    const wecomClient = new WeComClient();
    async function saveAndQueue(raw) {
        // 回调路由只负责验签、解密和入队；平台字段转换统一交给 Adapter，保持企业微信和 RPA 链路一致。
        const unified = await adapter.parseInbound(raw);
        const saved = await messageService.saveInboundMessage(unified);
        if (!saved.duplicated) {
            await inboundMessageQueue.add('reply', { messageId: saved.message.id });
        }
        return saved;
    }
    async function handleVerify(request, reply) {
        const query = request.query;
        const plainText = verifyWeComUrl({
            token: env.WECOM_TOKEN,
            encodingAESKey: env.WECOM_AES_KEY,
            corpId: env.WECOM_CORP_ID,
            msgSignature: query.msg_signature,
            timestamp: query.timestamp,
            nonce: query.nonce,
            echostr: query.echostr
        });
        return reply.type('text/plain').send(plainText);
    }
    async function handleCallback(request, reply) {
        const body = request.body;
        if (typeof body !== 'string') {
            // JSON 分支只用于本地模拟测试，不走企业微信验签。
            // 真实企业微信回调会以 XML 文本进入下面的解密流程。
            const saved = await saveAndQueue(body);
            return reply.send({ ok: true, duplicated: saved.duplicated });
        }
        const query = request.query;
        const decryptedXml = decryptWeComMessage({
            token: env.WECOM_TOKEN,
            encodingAESKey: env.WECOM_AES_KEY,
            corpId: env.WECOM_CORP_ID,
            msgSignature: query.msg_signature,
            timestamp: query.timestamp,
            nonce: query.nonce,
            encryptedXml: body
        });
        const event = parseWeComXml(decryptedXml);
        if (event.MsgType === 'text' && event.Content) {
            await saveAndQueue({ source: 'wecom_app', event });
            return reply.type('text/plain').send('success');
        }
        if (event.MsgType === 'event' && event.Event === 'kf_msg_or_event') {
            // 客服事件只表示“有消息可同步”，必须调用 sync_msg 拉取真实文本内容。
            // kfCursor 放在进程内是 MVP 简化，生产环境应持久化到数据库或 Redis。
            try {
                const synced = await wecomClient.syncKfMessages({
                    token: String(event.Token ?? ''),
                    openKfid: String(event.OpenKfId ?? ''),
                    cursor: kfCursor
                });
                kfCursor = synced.nextCursor;
                for (const message of synced.messages) {
                    if (message.msgtype === 'text' && message.text?.content) {
                        await saveAndQueue({ source: 'wecom_kf', message });
                    }
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // 企业微信客服回调只是一条“有新消息”的通知；如果本机出口 IP 未加入企业微信白名单，
                // sync_msg 会返回 60020。这里仍向企微返回 success，避免平台反复重试把日志刷爆。
                app.log.warn({
                    err: message,
                    hint: '请把当前服务器出口公网 IP 加入企业微信 API 可信 IP / IP 白名单后重试'
                }, '企业微信 sync_msg 失败，已确认回调但未拉取消息');
            }
        }
        return reply.type('text/plain').send('success');
    }
    for (const path of wecomCallbackPaths) {
        // 企业微信后台配置回调 URL 时会先发 GET 验证。
        app.get(path, handleVerify);
        // 企业微信客服 Webhook；兼容旧网关路径，减少线上配置切换成本。
        app.post(path, handleCallback);
    }
}
