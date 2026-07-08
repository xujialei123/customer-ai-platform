// @ts-nocheck
import { env } from '../config/env.js';
const accessTokenCache = {
    token: '',
    expireAt: 0
};
export class WeComClient {
    // 企业微信 access_token 有有效期，统一缓存可以减少接口调用和限频风险。
    async getAccessToken() {
        const now = Date.now();
        if (accessTokenCache.token && accessTokenCache.expireAt > now) {
            return accessTokenCache.token;
        }
        if (!env.WECOM_CORP_ID || !env.WECOM_SECRET) {
            throw new Error('WECOM_CORP_ID / WECOM_SECRET 未配置');
        }
        const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
        url.searchParams.set('corpid', env.WECOM_CORP_ID);
        url.searchParams.set('corpsecret', env.WECOM_SECRET);
        const res = await fetch(url);
        const data = await res.json();
        if (data.errcode !== 0 || !data.access_token) {
            throw new Error(`获取企业微信 access_token 失败：${JSON.stringify(data)}`);
        }
        accessTokenCache.token = data.access_token;
        accessTokenCache.expireAt = now + ((data.expires_in ?? 7200) - 300) * 1000;
        return accessTokenCache.token;
    }
    // 微信客服回调只通知“有新消息”，真实消息需要通过 sync_msg 拉取。
    async syncKfMessages(input) {
        const accessToken = await this.getAccessToken();
        const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg');
        url.searchParams.set('access_token', accessToken);
        const messages = [];
        let cursor = input.cursor ?? '';
        let hasMore = 1;
        let nextCursor = cursor;
        while (hasMore) {
            // 企业微信客服消息可能分页返回，必须按 next_cursor 拉完。
            // 否则一次回调里多条用户消息会漏处理，后续回复上下文也会错位。
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cursor,
                    token: input.token,
                    limit: 100,
                    voice_format: 0,
                    open_kfid: input.openKfid
                })
            });
            const data = await res.json();
            if (data.errcode !== 0) {
                throw new Error(`企业微信 sync_msg 失败：${JSON.stringify(data)}`);
            }
            messages.push(...(data.msg_list ?? []));
            nextCursor = data.next_cursor ?? nextCursor;
            cursor = nextCursor;
            hasMore = data.has_more ?? 0;
        }
        return { messages, nextCursor };
    }
    // 发送企业微信客服文本消息。
    // 这里只封装官方 send_msg 调用，是否允许自动发送由 ReplyWorker / SafetyService 决定。
    async sendKfText(input) {
        const accessToken = await this.getAccessToken();
        const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg');
        url.searchParams.set('access_token', accessToken);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                touser: input.touser,
                open_kfid: input.openKfid,
                msgtype: 'text',
                text: { content: input.content }
            })
        });
        const data = await res.json();
        if (data.errcode !== 0) {
            throw new Error(`企业微信客服 send_msg 失败：${JSON.stringify(data)}`);
        }
        return data;
    }
    // 发送企业微信自建应用文本消息。
    // 这个通道和微信客服通道不同，必须带 agentid，所以单独封装，避免两类会话混用参数。
    async sendAppText(input) {
        const accessToken = await this.getAccessToken();
        if (!env.WECOM_AGENT_ID) {
            throw new Error('WECOM_AGENT_ID 未配置，无法发送企业微信自建应用消息');
        }
        const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
        url.searchParams.set('access_token', accessToken);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                touser: input.touser,
                msgtype: 'text',
                agentid: env.WECOM_AGENT_ID,
                text: { content: input.content },
                safe: 0,
                enable_duplicate_check: 0,
                duplicate_check_interval: 1800
            })
        });
        const data = await res.json();
        if (data.errcode !== 0) {
            throw new Error(`企业微信应用消息发送失败：${JSON.stringify(data)}`);
        }
        return data;
    }
}
