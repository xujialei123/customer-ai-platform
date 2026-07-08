// @ts-nocheck
import { nanoid } from 'nanoid';
import { WeComClient } from '../services/wecom-client.service.js';
// 企业微信 Adapter。
// 回调层负责验签/解密，这里只做平台消息到 UnifiedMessage 的转换和统一发送出口。
export class WeComAdapter {
    platform = 'wecom';
    client = new WeComClient();
    async parseInbound(raw) {
        const payload = raw;
        if (payload.source === 'wecom_kf') {
            return this.parseKfMessage(payload.message);
        }
        if (payload.source === 'wecom_app') {
            return this.parseAppMessage(payload.event);
        }
        // 保留 JSON 模拟能力，方便本地测试统一链路。
        return {
            id: payload.id ?? nanoid(),
            platform: 'wecom',
            shopId: payload.shopId ?? 'default-shop',
            conversationId: payload.conversationId ?? payload.external_userid ?? 'wecom-conv-demo',
            customerId: payload.customerId ?? payload.external_userid ?? 'wecom-customer-demo',
            customerName: payload.customerName,
            messageType: payload.messageType ?? 'text',
            content: payload.content ?? payload.text ?? '',
            raw: payload,
            createdAt: payload.createdAt ?? new Date().toISOString()
        };
    }
    async sendMessage(params) {
        try {
            if (params.conversationId.startsWith('kf:')) {
                const [, openKfid] = params.conversationId.split(':');
                if (!openKfid) {
                    throw new Error(`无法从会话 ID 解析 open_kfid：${params.conversationId}`);
                }
                const raw = await this.client.sendKfText({
                    touser: params.customerId,
                    openKfid,
                    content: params.content
                });
                return { success: true, raw };
            }
            if (params.conversationId.startsWith('app:')) {
                // 自建应用消息和客服消息的发送接口不同，通过会话前缀明确区分，避免误用 send_msg。
                const raw = await this.client.sendAppText({
                    touser: params.customerId,
                    content: params.content
                });
                return { success: true, raw };
            }
            throw new Error(`未知企业微信会话类型：${params.conversationId}`);
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    parseKfMessage(message) {
        const openKfid = message.open_kfid;
        const externalUserId = message.external_userid;
        if (!openKfid || !externalUserId) {
            throw new Error('企业微信客服消息缺少 open_kfid 或 external_userid');
        }
        return {
            id: message.msgid ?? nanoid(),
            platform: 'wecom',
            // 微信客服没有天然的本系统 shopId，这里先使用 open_kfid 作为店铺/客服账号维度。
            // 后续多门店场景可以通过 platform_accounts 把 open_kfid 映射到真实 shop。
            shopId: openKfid,
            conversationId: `kf:${openKfid}:${externalUserId}`,
            customerId: externalUserId,
            messageType: message.msgtype === 'text' ? 'text' : 'unknown',
            content: message.text?.content ?? '',
            raw: message,
            createdAt: message.send_time ? new Date(message.send_time).toISOString() : new Date().toISOString()
        };
    }
    parseAppMessage(event) {
        const fromUser = String(event.FromUserName ?? '');
        if (!fromUser) {
            throw new Error('企业微信自建应用消息缺少 FromUserName');
        }
        return {
            id: String(event.MsgId ?? nanoid()),
            platform: 'wecom',
            // 自建应用消息没有客服账号 ID，先用固定 shopId 区分来源，避免和微信客服会话混在一起。
            shopId: 'wecom-app',
            conversationId: `app:${fromUser}`,
            customerId: fromUser,
            messageType: event.MsgType === 'text' ? 'text' : 'unknown',
            content: String(event.Content ?? ''),
            raw: event,
            createdAt: event.CreateTime ? new Date(Number(event.CreateTime) * 1000).toISOString() : new Date().toISOString()
        };
    }
}
