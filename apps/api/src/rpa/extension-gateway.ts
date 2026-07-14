// @ts-nocheck
/**
 * @file apps/api/src/rpa/extension-gateway.ts
 * @module RPA 与 Chrome 插件
 * @description 本地 WebSocket 网关：会话注册、messageId 草稿关联和状态推送。
 * @see 联动关注：background.js 通信协议。
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { buildRpaAllowlistStatus, isRpaCustomerAllowed } from './customer-allowlist.js';
import { terminalLog } from '../utils/terminal-log.js';

const clients = new Set();

function sendFrame(socket, payload) {
    // 服务端只发送 UTF-8 JSON 文本帧；扩展协议不传 Cookie、密码或二进制页面数据。
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const header = body.length < 126
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
    socket.write(Buffer.concat([header, body]));
}

function parseFrames(state, chunk, onMessage) {
    // TCP 数据可能拆包或粘包，因此必须按 WebSocket 帧长度累积解析，不能假设一次 data 就是一条消息。
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= 2) {
        const first = state.buffer[0];
        const second = state.buffer[1];
        const opcode = first & 0x0f;
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (state.buffer.length < 4)
                return;
            length = state.buffer.readUInt16BE(2);
            offset = 4;
        }
        // 扩展只传递短文本事件；拒绝超大帧，避免本地端口被意外页面滥用。
        if (length === 127 || length > 64 * 1024) {
            state.socket.destroy();
            return;
        }
        const maskLength = masked ? 4 : 0;
        if (state.buffer.length < offset + maskLength + length)
            return;
        const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
        offset += maskLength;
        const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
        state.buffer = state.buffer.subarray(offset + length);
        if (mask) {
            for (let index = 0; index < payload.length; index += 1)
                payload[index] ^= mask[index % 4];
        }
        if (opcode === 0x8) {
            state.socket.end();
            return;
        }
        if (opcode === 0x9) {
            state.socket.write(Buffer.from([0x8a, payload.length, ...payload]));
            continue;
        }
        if (opcode === 0x1)
            onMessage(payload.toString('utf-8'));
    }
}

async function fetchRecentDrafts(session, apiBaseUrl) {
    const conversationIds = [session.conversationId].filter(Boolean);
    if (session.platform === 'douyin') {
        if (session.customerName && !conversationIds.includes(session.customerName))
            conversationIds.push(session.customerName);
        if (session.customerId && !conversationIds.includes(session.customerId))
            conversationIds.push(session.customerId);
    }
    let lastResult = { drafts: [] };
    for (const conversationId of conversationIds) {
        const url = new URL('/reply-drafts/recent', apiBaseUrl);
        url.searchParams.set('platform', session.platform);
        url.searchParams.set('shopId', session.shopId);
        url.searchParams.set('conversationId', conversationId);
        url.searchParams.set('limit', '20');
        const response = await fetch(url);
        if (!response.ok)
            continue;
        const result = await response.json();
        lastResult = result;
        if ((result.drafts ?? []).length > 0)
            return result;
    }
    return lastResult;
}

async function readDrafts(client, apiBaseUrl) {
    // 每个连接串行轮询草稿，防止定时器重入把同一 pending 草稿下发多次。
    if (client.pollingDrafts)
        return;
    client.pollingDrafts = true;
    try {
    const polledSessions = new Set();
    for (const session of client.sessions.values()) {
        const pollKey = `${session.platform}:${session.shopId}:${session.conversationId}:${session.customerName || ''}`;
        if (polledSessions.has(pollKey))
            continue;
        polledSessions.add(pollKey);
        if (!isRpaCustomerAllowed(session)) {
            // 白名单变更或旧 content script 重连时，旧会话不能继续轮询草稿，防止正式页误回非测试客户。
            client.sessions.delete(`${session.platform}:${session.conversationId}`);
            continue;
        }
        const result = await fetchRecentDrafts(session, apiBaseUrl);
        const unsentDrafts = (result.drafts ?? []).filter((draft) => ['pending', 'approved'].includes(draft.status));
        // 等扩展同步完 autoSend 开关再推草稿，避免首轮轮询在 client_settings 到达前把草稿按“仅回填”烧掉。
        if (!client.settingsReady)
            continue;
        // 已确认发送过的问题才跳过；不要仅因页面回扫到旧气泡就 reject 新草稿。
        const unrepliedDrafts = unsentDrafts.filter((draft) => draft.alreadyReplied !== true);
        for (const draft of unsentDrafts) {
            if (draft.alreadyReplied === true && !client.draftPushState.has(draft.id)) {
                client.draftPushState.set(draft.id, { allowAutoSend: false, skipped: true, reason: 'already_replied' });
                terminalLog('warn', {
                    platform: session.platform,
                    customer: session.customerName || session.customerId || session.conversationId,
                    denyReason: 'already_replied',
                    userMessage: draft.userMessage,
                    content: draft.content
                });
            }
        }
        // 只推本轮刚入库消息对应的草稿；没有匹配时绝不回退到历史 pending。
        // 否则 OpenClaw 较慢时，会把上一问未清掉的草稿再次填进输入框并自动发送。
        const matchedDrafts = unrepliedDrafts.filter((draft) => client.expectedMessageIds.has(draft.messageId));
        const candidates = matchedDrafts;
        // 自动发送每轮最多处理一条，避免连点。
        const draftsToPush = client.autoSendEnabled ? candidates.slice(-1) : candidates;
        for (const draft of unrepliedDrafts) {
            if (candidates.some((item) => item.id === draft.id))
                continue;
            if (!client.draftPushState.has(draft.id))
                client.draftPushState.set(draft.id, { allowAutoSend: false, skipped: true, reason: 'not_latest_unreplied' });
        }
        for (const draft of draftsToPush) {
            if (draft.status === 'sent')
                continue;
            const previousPush = client.draftPushState.get(draft.id);
            if (previousPush?.skipped)
                continue;
            // 仅当客户端明确回报点击失败时才重推；禁止「20 秒无回执」把同一条旧回复再发一遍。
            if (previousPush?.clicked === true)
                continue;
            if (previousPush?.allowAutoSend === true && previousPush?.clickFailed !== true)
                continue;
            if (previousPush?.allowAutoSend && previousPush?.clickFailed === true) {
                const pushedAt = previousPush.pushedAt ?? 0;
                if (Date.now() - pushedAt < 8000)
                    continue;
            }
            const isExpectedMessage = client.expectedMessageIds.has(draft.messageId);
            const cooldownPassed = Date.now() - client.lastAutoSendAt >= 8000;
            const allowPlatformRpaAutoSend = isRpaCustomerAllowed(session);
            // 冷却未到时不要烧掉 expectedMessageId，也不要 fill_only 占位，等下一轮再自动发送最新一条。
            if (client.autoSendEnabled
                && env.RPA_AUTO_SEND_ENABLED
                && isExpectedMessage
                && draft.riskLevel === 'low'
                && draft.alreadyReplied !== true
                && allowPlatformRpaAutoSend
                && !cooldownPassed) {
                continue;
            }
            const allowAutoSend = Boolean(client.autoSendEnabled)
                && env.RPA_AUTO_SEND_ENABLED
                && draft.riskLevel === 'low'
                && draft.alreadyReplied !== true
                && cooldownPassed
                && isExpectedMessage
                && allowPlatformRpaAutoSend;
            const denyReason = allowAutoSend
                ? ''
                : draft.alreadyReplied === true
                    ? 'already_replied'
                    : !client.autoSendEnabled
                        ? 'extension_auto_send_off'
                        : !env.RPA_AUTO_SEND_ENABLED
                            ? 'server_rpa_auto_send_off'
                            : draft.riskLevel !== 'low'
                                ? `risk_${draft.riskLevel}`
                                : (!isExpectedMessage || !allowPlatformRpaAutoSend)
                                    ? 'session_not_authorized'
                                    : 'unknown';
            // 已经 fill_only 过且本次仍不能自动发送：不要反复刷输入框。
            if (previousPush && !previousPush.allowAutoSend && !allowAutoSend)
                continue;
            client.draftPushState.set(draft.id, { allowAutoSend, pushedAt: Date.now(), clicked: null, clickFailed: false });
            if (allowAutoSend || draft.alreadyReplied === true || !isExpectedMessage)
                client.expectedMessageIds.delete(draft.messageId);
            if (allowAutoSend)
                client.lastAutoSendAt = Date.now();
            sendFrame(client.socket, {
                type: 'draft',
                session,
                payload: {
                    ...draft,
                    allowAutoSend,
                    denyReason
                }
            });
            terminalLog(allowAutoSend ? 'push' : 'fill_only', {
                platform: session.platform,
                customer: session.customerName || session.customerId || session.conversationId,
                riskLevel: draft.riskLevel,
                allowAutoSend,
                denyReason: denyReason || undefined,
                userMessage: draft.userMessage,
                content: draft.content
            });
        }
    }
    }
    finally {
        client.pollingDrafts = false;
    }
}

async function handleMessage(client, apiBaseUrl, raw) {
    // 所有扩展事件在这里做白名单分发，浏览器不能指定任意后端 URL 或执行任意动作。
    let message;
    try {
        message = JSON.parse(raw);
    }
    catch {
        sendFrame(client.socket, { type: 'error', error: 'WebSocket 消息必须是 JSON' });
        return;
    }
    if (message.type === 'hello') {
        if (!isRpaCustomerAllowed(message.payload)) {
            sendFrame(client.socket, { type: 'ignored_session', payload: { reason: 'customer_not_allowed', session: message.payload } });
            return;
        }
        const session = message.payload;
        const keys = new Set([session.conversationId, session.customerName, session.customerId].filter(Boolean));
        for (const key of keys)
            client.sessions.set(`${session.platform}:${key}`, session);
        sendFrame(client.socket, { type: 'connected', payload: { clientId: client.id, ...buildRpaAllowlistStatus() } });
        return;
    }
    if (message.type === 'reset_sessions') {
        // 扩展重连后清除旧 frame 注册，避免页面结构调整后把历史占位会话继续路由到当前客户。
        client.sessions.clear();
        return;
    }
    if (message.type === 'remove_session') {
        const session = message.payload;
        const keys = new Set([session.conversationId, session.customerName, session.customerId].filter(Boolean));
        for (const key of keys)
            client.sessions.delete(`${session.platform}:${key}`);
        return;
    }
    if (message.type === 'heartbeat') {
        sendFrame(client.socket, { type: 'heartbeat_ack', timestamp: Date.now() });
        return;
    }
    if (message.type === 'client_settings') {
        // 只接受布尔值，且设置仅属于当前扩展连接；断线后必须由扩展从持久化存储重新同步。
        const nextEnabled = message.payload?.autoSendEnabled === true;
        if (nextEnabled && !client.autoSendEnabled)
            client.autoSendEnabledAt = Date.now();
        client.autoSendEnabled = nextEnabled;
        client.settingsReady = true;
        return;
    }
    if (message.type === 'diagnostics') {
        // 诊断只保存选择器结构和命中数量，不接收聊天正文，避免调试接口泄露客户信息。
        client.diagnostics.set(message.payload.pageUrl, message.payload);
        return;
    }
    if (message.type === 'draft_send_result') {
        // 插件回传是否点到发送按钮；这里只进入 dispatching，页面真实出现 outbound 后才确认 sent。
        const payload = message.payload ?? {};
        terminalLog(payload.clicked ? 'click_ok' : (payload.filledOnly ? 'fill_only' : 'click_fail'), {
            platform: payload.platform,
            customer: payload.customerName || payload.customerId || payload.conversationId,
            riskLevel: payload.riskLevel,
            allowAutoSend: payload.allowAutoSend,
            denyReason: payload.denyReason,
            clicked: payload.clicked,
            method: payload.method,
            content: payload.content
        });
        if (payload.draftId) {
            if (payload.clicked === true) {
                client.draftPushState.set(payload.draftId, {
                    allowAutoSend: true,
                    clicked: true,
                    skipped: true,
                    reason: 'client_clicked',
                    pushedAt: Date.now()
                });
                try {
                    const response = await fetch(new URL(`/reply-drafts/${payload.draftId}/mark-dispatched`, apiBaseUrl), { method: 'POST' });
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                } catch (error) {
                    terminalLog('warn', {
                        platform: payload.platform,
                        customer: payload.customerName || payload.customerId || payload.conversationId,
                        denyReason: 'mark_dispatched_failed',
                        content: error instanceof Error ? error.message : String(error)
                    });
                }
            } else if (payload.allowAutoSend === true) {
                const previous = client.draftPushState.get(payload.draftId) ?? {};
                client.draftPushState.set(payload.draftId, {
                    ...previous,
                    allowAutoSend: true,
                    clicked: false,
                    clickFailed: true,
                    pushedAt: previous.pushedAt ?? Date.now()
                });
            }
        }
        return;
    }
    if (!['inbound', 'outbound'].includes(message.type))
        return;
    if (!isRpaCustomerAllowed(message.payload)) {
        // 线上灰度时非白名单客户直接丢弃，不入库、不排队、不推草稿，防止真实经营宝误回。
        sendFrame(client.socket, {
            type: `${message.type}_ack`,
            requestId: message.requestId,
            payload: { ok: true, ignored: true, reason: 'customer_not_allowed' }
        });
        return;
    }
    if (message.type === 'inbound' && message.payload?.id) {
        // 同一会话只保留最新入站期望草稿，避免抖音历史 pending 排队连发。
        const conversationId = String(message.payload.conversationId || '');
        if (conversationId) {
            for (const existingId of [...client.expectedMessageIds]) {
                if (String(existingId).startsWith(`${conversationId}:`))
                    client.expectedMessageIds.delete(existingId);
            }
        }
        client.expectedMessageIds.add(message.payload.id);
    }
    const endpoint = message.type === 'outbound' ? '/rpa/outbound' : '/rpa/inbound';
    const response = await fetch(new URL(endpoint, apiBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(message.payload)
    });
    const result = await response.json().catch(() => ({ ok: false }));
    // 重复入站（含内容短时去重）不会生成新草稿；清掉本次抖动 ID，避免卡住 expected 集合。
    if (message.type === 'inbound' && message.payload?.id && (result.duplicated || !response.ok))
        client.expectedMessageIds.delete(message.payload.id);
    sendFrame(client.socket, {
        type: response.ok ? `${message.type}_ack` : 'error',
        requestId: message.requestId,
        payload: result
    });
}

/**
 * 在 Fastify 的 HTTP Server 上挂载本机 WebSocket。
 * 扩展运行在用户正常 Chrome 会话中，因此这里只负责桥接消息，不接触账号、密码或 Cookie。
 */
export function registerRpaExtensionGateway(server, apiPort) {
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    server.on('upgrade', (request, socket) => {
        const requestUrl = new URL(request.url ?? '/', apiBaseUrl);
        if (requestUrl.pathname !== '/rpa/extension/ws')
            return;
        const remoteAddress = socket.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
            socket.destroy();
            return;
        }
        const key = request.headers['sec-websocket-key'];
        if (!key) {
            socket.destroy();
            return;
        }
        const accept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '\r\n'
        ].join('\r\n'));
        const client = {
            id: crypto.randomUUID(),
            socket,
            buffer: Buffer.alloc(0),
            sessions: new Map(),
            diagnostics: new Map(),
            autoSendEnabled: false,
            autoSendEnabledAt: Number.POSITIVE_INFINITY,
            settingsReady: false,
            connectedAt: Date.now(),
            pollingDrafts: false,
            lastAutoSendAt: 0,
            draftPushState: new Map(),
            expectedMessageIds: new Set()
        };
        clients.add(client);
        sendFrame(socket, { type: 'connected', payload: { clientId: client.id, ...buildRpaAllowlistStatus() } });
        socket.on('data', (chunk) => parseFrames(client, chunk, (raw) => {
            void handleMessage(client, apiBaseUrl, raw).catch((error) => {
                sendFrame(socket, { type: 'error', error: error instanceof Error ? error.message : String(error) });
            });
        }));
        socket.on('close', () => clients.delete(client));
        socket.on('error', () => clients.delete(client));
    });
    const timer = setInterval(() => {
        for (const client of clients)
            void readDrafts(client, apiBaseUrl);
    }, 1500);
    timer.unref();
}

export function getRpaExtensionStatus() {
    // 状态接口只暴露会话标识和脱敏诊断，不返回聊天正文、鉴权信息或完整 DOM。
    return {
        connectedClients: clients.size,
        sessions: [...clients].flatMap((client) => [...client.sessions.values()]),
        autoSendClients: [...clients].filter((client) => client.autoSendEnabled).length,
        // 方便对照：弹窗开了自动发送但这里是 false 时，说明 API 进程没读到最新 .env，需要重启 pnpm dev。
        rpaAutoSendEnabled: env.RPA_AUTO_SEND_ENABLED,
        ...buildRpaAllowlistStatus(),
        diagnostics: [...clients].flatMap((client) => [...client.diagnostics.values()])
    };
}

/**
 * 白名单在配置页变更后，主动推给已连接扩展，避免必须重连才生效。
 */
export function broadcastRpaAllowlistUpdate() {
    const payload = buildRpaAllowlistStatus();
    for (const client of clients)
        sendFrame(client.socket, { type: 'connected', payload: { clientId: client.id, ...payload } });
    return payload;
}
