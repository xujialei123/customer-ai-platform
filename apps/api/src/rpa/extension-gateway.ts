// @ts-nocheck
import { createHash } from 'node:crypto';

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

async function readDrafts(client, apiBaseUrl) {
    // 每个连接串行轮询草稿，防止定时器重入把同一 pending 草稿下发多次。
    if (client.pollingDrafts)
        return;
    client.pollingDrafts = true;
    try {
    for (const session of client.sessions.values()) {
        const url = new URL('/reply-drafts/recent', apiBaseUrl);
        url.searchParams.set('platform', session.platform);
        url.searchParams.set('shopId', session.shopId);
        url.searchParams.set('conversationId', session.conversationId);
        url.searchParams.set('limit', '20');
        const response = await fetch(url);
        if (!response.ok)
            continue;
        const result = await response.json();
        const unsentDrafts = (result.drafts ?? []).filter((draft) => draft.status !== 'sent' && !client.sentDrafts.has(draft.id));
        // 自动发送每轮最多处理当前会话的一条新草稿，避免历史积压或并发轮询造成连续发送。
        const draftsToPush = client.autoSendEnabled ? unsentDrafts.slice(-1) : unsentDrafts;
        for (const draft of draftsToPush) {
            if (draft.status === 'sent' || client.sentDrafts.has(draft.id))
                continue;
            client.sentDrafts.add(draft.id);
            const draftCreatedAt = new Date(draft.createdAt).getTime();
            const autoSendCutoff = Math.max(client.autoSendEnabledAt, client.connectedAt);
            const cooldownPassed = Date.now() - client.lastAutoSendAt >= 8000;
            const allowAutoSend = Boolean(client.autoSendEnabled)
                && draft.riskLevel === 'low'
                && draftCreatedAt >= autoSendCutoff
                && cooldownPassed;
            if (allowAutoSend)
                client.lastAutoSendAt = Date.now();
            sendFrame(client.socket, {
                type: 'draft',
                session,
                payload: {
                    ...draft,
                    // Chrome 扩展模式以操作员在扩展中的显式开关为授权源；高风险和会话校验仍在后续保留。
                    // 历史 pending 草稿只能人工处理；自动发送只接受本次连接中明确开启开关后新生成的草稿。
                    allowAutoSend
                }
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
        const sessionKey = `${message.payload.platform}:${message.payload.conversationId}`;
        client.sessions.set(sessionKey, message.payload);
        sendFrame(client.socket, { type: 'connected', payload: { clientId: client.id } });
        return;
    }
    if (message.type === 'reset_sessions') {
        // 扩展重连后清除旧 frame 注册，避免页面结构调整后把历史占位会话继续路由到当前客户。
        client.sessions.clear();
        return;
    }
    if (message.type === 'remove_session') {
        const sessionKey = `${message.payload.platform}:${message.payload.conversationId}`;
        client.sessions.delete(sessionKey);
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
        return;
    }
    if (message.type === 'diagnostics') {
        // 诊断只保存选择器结构和命中数量，不接收聊天正文，避免调试接口泄露客户信息。
        client.diagnostics.set(message.payload.pageUrl, message.payload);
        return;
    }
    if (!['inbound', 'outbound'].includes(message.type))
        return;
    const endpoint = message.type === 'outbound' ? '/rpa/outbound' : '/rpa/inbound';
    const response = await fetch(new URL(endpoint, apiBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(message.payload)
    });
    const result = await response.json().catch(() => ({ ok: false }));
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
            connectedAt: Date.now(),
            pollingDrafts: false,
            lastAutoSendAt: 0,
            sentDrafts: new Set()
        };
        clients.add(client);
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
        diagnostics: [...clients].flatMap((client) => [...client.diagnostics.values()])
    };
}
