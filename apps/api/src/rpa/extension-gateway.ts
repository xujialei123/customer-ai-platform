// @ts-nocheck
/**
 * @file apps/api/src/rpa/extension-gateway.ts
 * @module RPA 与 Chrome 插件
 * @description 本机 WebSocket 桥：Chrome 扩展 ↔ API。
 *
 * 主链路（务必按顺序理解）：
 * 1. 插件上报 inbound → 本文件先登记 expectedMessageId（乐观）
 * 2. POST /rpa/inbound 入库并进 ReplyWorker
 * 3. 定时 readDrafts：按 expected / 孤儿兜底 选出草稿
 * 4. 推 draft 帧：allowAutoSend=true 可点击发送，否则仅回填
 * 5. 插件回 draft_send_result → mark-dispatched
 * 6. 页面出现 outbound 后才算真正 sent
 *
 * @see background.js 协议、content.js 串行锁、reply-drafts 路由
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { buildRpaAllowlistStatus, isRpaCustomerAllowed } from './customer-allowlist.js';
import { terminalLog } from '../utils/terminal-log.js';

/** 当前已握手的扩展连接（通常一机一个扩展，可挂美团+抖音多 frame）。 */
const clients = new Set();

/** 同平台两次自动发送的最小间隔，防连点。 */
const AUTO_SEND_COOLDOWN_MS = 8000;
/** 点击失败后，至少间隔多久才允许重推。 */
const CLICK_RETRY_COOLDOWN_MS = 8000;
/** fill_only 重复回填的最短间隔；切回话后首次可能落空，超时再补推。 */
const FILL_ONLY_REPUSH_MS = 25000;
/**
 * 孤儿草稿（无 expected 匹配）默认可补推多久。
 * API/插件重连后常见 pending>0 expected=0；窗口过短会导致草稿永久躺库。
 */
const ORPHAN_RESCUE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/**
 * 已推送「允许自动发送」但迟迟无 click 回报：视为在途失败，允许孤儿再推。
 * （插件未就绪、切到别的平台页、resolveDraftTarget 丢帧都会造成这种悬挂。）
 */
const AUTO_SEND_INFLIGHT_STALE_MS = 60000;
/** 草稿轮询间隔。 */
const DRAFT_POLL_INTERVAL_MS = 1500;

// ---------------------------------------------------------------------------
// WebSocket 底层：发帧 / 拆包
// ---------------------------------------------------------------------------

/** 向扩展写一条 JSON 文本帧（不传 Cookie / 密码 / 二进制页面）。 */
function sendFrame(socket, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    const header = body.length < 126
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
    socket.write(Buffer.concat([header, body]));
}

/**
 * 手工解析 WebSocket 帧。
 * TCP 会拆包/粘包，不能假设一次 data 就是一条完整消息；只接受文本帧，超大帧断开。
 */
function parseFrames(state, chunk, onMessage) {
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

// ---------------------------------------------------------------------------
// 草稿查询与推送判定（核心业务）
// ---------------------------------------------------------------------------

/**
 * 按会话拉最近草稿。
 * 抖音主键可能是昵称 / groupId / customerId，需多 key 兜底。
 */
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

/**
 * 决定本条草稿是否允许插件自动点击发送，以及不允许时的原因码。
 *
 * 全部满足才 allowAutoSend=true：
 * - 弹窗开了自动发送
 * - .env RPA_AUTO_SEND_ENABLED=true
 * - 风险等级 low
 * - 页面尚未回复过同一问
 * - 已过平台冷却
 * - 属于当前期望消息（或孤儿兜底命中）
 * - 客户在白名单内（空白名单=全放行）
 *
 * denyReason 会显示在插件状态 / 终端日志，方便对照排查。
 */
function resolveAutoSendDecision(input) {
    const {
        client,
        draft,
        isExpectedMessage,
        allowPlatformRpaAutoSend,
        cooldownPassed
    } = input;

    if (draft.alreadyReplied === true)
        return { allowAutoSend: false, denyReason: 'already_replied' };
    if (!client.autoSendEnabled)
        return { allowAutoSend: false, denyReason: 'extension_auto_send_off' };
    if (!env.RPA_AUTO_SEND_ENABLED)
        return { allowAutoSend: false, denyReason: 'server_rpa_auto_send_off' };
    if (draft.riskLevel !== 'low')
        return { allowAutoSend: false, denyReason: `risk_${draft.riskLevel}` };
    if (!isExpectedMessage || !allowPlatformRpaAutoSend)
        return { allowAutoSend: false, denyReason: 'session_not_authorized' };
    if (!cooldownPassed)
        return { allowAutoSend: false, denyReason: 'platform_cooldown' };

    return { allowAutoSend: true, denyReason: '' };
}

/**
 * 孤儿草稿：库里有 pending，但本连接 expected 对不上（竞态 / 重连 / duplicated）。
 * 近 ORPHAN_RESCUE_MAX_AGE_MS 内、且未成功点击过的，允许兜底推一次。
 */
/**
 * 判断一条「没人对上号」的草稿要不要兜底推给插件。
 *
 * 正常路径：插件 inbound 时登记 expectedMessageId → Worker 出草稿 →
 * 轮询里用 draft.messageId ∈ expected 命中再推。这叫 matched。
 *
 * 孤儿路径：库里已有 pending 草稿，但本连接 expected 里没有对应 id
 * （常见原因：入库与登记竞态、消息 duplicated 后 expected 被清掉、扩展刚重连）。
 * 若不兜底，会出现终端里 pending>0 expected=0、客户永远收不到回填。
 *
 * 返回 true = 可以当孤儿候选推一次；false = 不要救。
 */
function isOrphanRescueCandidate(draft, matchedDrafts, draftPushState) {
    // 已经能靠 expected 正常匹配到，不必走孤儿通道。
    if (matchedDrafts.some((item) => item.id === draft.id))
        return false;

    // 太久远的草稿不再补推，避免把几小时前的旧答再发一遍。
    const createdAt = new Date(draft.createdAt || 0).getTime();
    if (!createdAt || Date.now() - createdAt > ORPHAN_RESCUE_MAX_AGE_MS)
        return false;

    const previous = draftPushState.get(draft.id);

    // 插件已回报点过发送：这件事结束了，不要再推。
    if (previous?.clicked === true)
        return false;

    // 曾经带着「允许自动发送」推过，且没有 clickFailed：短时视为在途。
    // 超时仍无 click → 多半插件页不在/丢帧，必须允许再救，否则抖音草稿会永久卡住。
    if (previous?.allowAutoSend === true && previous?.clickFailed !== true) {
        const age = Date.now() - (previous.pushedAt ?? 0);
        if (age < AUTO_SEND_INFLIGHT_STALE_MS)
            return false;
    }

    // skipped=true 且原因是永久结案（如 already_replied）→ 不救。
    // not_latest_unreplied / orphan_pending_warn 只是「当时轮到别的稿」或诊断标记，仍可再试。
    if (previous?.skipped && !['not_latest_unreplied', 'orphan_pending_warn'].includes(previous.reason))
        return false;

    return true;
}

/**
 * 根据上次推送状态决定：本轮要不要跳过这条草稿。
 * 返回 true = 本轮不推。
 *
 * 切回话后轮询仍会扫到旧 pending：绝不能再次「自动发送」。
 * 规则：只要本连接曾经推过/点过这条，就不再推自动发送；fill_only 也严格限频。
 */
function shouldSkipDueToPreviousPush(previousPush, nextAllowAutoSend) {
    if (!previousPush)
        return false;
    // 页面已回复过 / 插件已点发送：永久跳过。
    if (previousPush.skipped && previousPush.reason === 'already_replied')
        return true;
    if (previousPush.reason === 'client_clicked' || previousPush.clicked === true)
        return true;
    // 曾经授权过自动发送且未报点击失败：短时禁止重推；超时无回执则放行（避免丢帧后永不发送）。
    if (previousPush.allowAutoSend === true && previousPush.clickFailed !== true) {
        const age = Date.now() - (previousPush.pushedAt ?? 0);
        if (age < AUTO_SEND_INFLIGHT_STALE_MS)
            return true;
    }
    // 点击失败：冷却内不重推；冷却后只允许再试一次自动点（仍走下方逻辑）。
    if (previousPush.allowAutoSend && previousPush.clickFailed === true) {
        const age = Date.now() - (previousPush.pushedAt ?? 0);
        if (age < CLICK_RETRY_COOLDOWN_MS)
            return true;
        return false;
    }
    // 曾 fill_only：禁止升级为自动发送再点一次；仅允许限频补填输入框。
    if (previousPush.pushedAt && nextAllowAutoSend)
        return true;
    if (previousPush.pushedAt && !previousPush.allowAutoSend) {
        const age = Date.now() - (previousPush.pushedAt ?? 0);
        if (age < FILL_ONLY_REPUSH_MS)
            return true;
    }
    return false;
}

/** 平台维度的自动发送冷却是否已过。 */
function hasPlatformCooldownPassed(client, platform) {
    if (!client.lastAutoSendAtByPlatform)
        client.lastAutoSendAtByPlatform = new Map();
    const lastAt = client.lastAutoSendAtByPlatform.get(platform) ?? 0;
    return Date.now() - lastAt >= AUTO_SEND_COOLDOWN_MS;
}

/** 向扩展下发一条草稿，并更新本地推送状态 / expected。 */
function pushDraftFrame(client, session, draft, allowAutoSend, denyReason, isExpectedMessage) {
    client.draftPushState.set(draft.id, {
        allowAutoSend,
        pushedAt: Date.now(),
        clicked: null,
        clickFailed: false
    });
    // 自动发送或无需再等：清 expected，避免下一轮重复匹配。
    if (allowAutoSend || draft.alreadyReplied === true || !isExpectedMessage) {
        client.expectedMessageIds.delete(draft.messageId);
        client.expectedMessageMeta?.delete?.(draft.messageId);
    }
    if (allowAutoSend) {
        client.lastAutoSendAt = Date.now();
        client.lastAutoSendAtByPlatform.set(session.platform, Date.now());
    }
    sendFrame(client.socket, {
        type: 'draft',
        session,
        payload: { ...draft, allowAutoSend, denyReason }
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

/**
 * 处理单个会话的草稿轮询与推送。
 * 选稿优先级：expected 匹配（按时间 FIFO）> 孤儿兜底（最多 1 条）。
 * 同客户连发多问时每轮只推最早未回的一条，点完再推下一条。
 */
async function pollAndPushSessionDrafts(client, session, apiBaseUrl) {
    const result = await fetchRecentDrafts(session, apiBaseUrl);
    // pending/approved 才可推；dispatching=已点发送待确认，切回话也绝不能再推。
    const unsentDrafts = (result.drafts ?? []).filter((draft) => ['pending', 'approved'].includes(draft.status));

    const byCreatedAsc = (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();

    // alreadyReplied：页面已有同问商家回复；只静默登记，终端不刷全文。
    const unrepliedDrafts = unsentDrafts
        .filter((draft) => draft.alreadyReplied !== true)
        .slice()
        .sort(byCreatedAsc);
    for (const draft of unsentDrafts) {
        if (draft.alreadyReplied === true && !client.draftPushState.has(draft.id)) {
            client.draftPushState.set(draft.id, {
                allowAutoSend: false,
                skipped: true,
                reason: 'already_replied'
            });
        }
    }

    // 优先推「当前期望入站消息」对应的草稿；同客户多条按时间从早到晚。
    const matchedDrafts = unrepliedDrafts
        .filter((draft) => client.expectedMessageIds.has(draft.messageId))
        .sort(byCreatedAsc);
    const recentOrphanRescue = unrepliedDrafts.filter((draft) => (
        isOrphanRescueCandidate(draft, matchedDrafts, client.draftPushState)
    )).sort(byCreatedAsc);
    // expected 空 + 孤儿过滤后仍空：再兜底最早一条 pending（重启残留也按 FIFO，避免跳着回）。
    let candidates = matchedDrafts.length > 0
        ? matchedDrafts
        : recentOrphanRescue.slice(0, 1);
    if (candidates.length === 0
        && unrepliedDrafts.length > 0
        && client.expectedMessageIds.size === 0) {
        candidates = unrepliedDrafts.slice(0, 1);
    }

    // 开了自动发送时每轮最多推 1 条（最早那条），防连点；发完后再轮询下一条。
    const draftsToPush = client.autoSendEnabled ? candidates.slice(0, 1) : candidates;

    // 诊断：有 pending、但本连接 expected 为空（常见于竞态或刚重连）。
    if (unrepliedDrafts.length > 0 && matchedDrafts.length === 0 && client.expectedMessageIds.size === 0) {
        const orphan = unrepliedDrafts[unrepliedDrafts.length - 1];
        if (orphan && !client.draftPushState.has(`warn:${orphan.id}`)) {
            client.draftPushState.set(`warn:${orphan.id}`, { skipped: false, reason: 'orphan_pending_warn' });
            terminalLog('warn', {
                platform: session.platform,
                customer: session.customerName || session.customerId || session.conversationId,
                denyReason: 'draft_waiting_expected_message',
                content: `pending=${unrepliedDrafts.length} expected=0 orphanRescue=${recentOrphanRescue.length}`
            });
        }
    }

    // 非候选草稿记「非最新」，不要用 skipped=true 永久烧死。
    for (const draft of unrepliedDrafts) {
        if (candidates.some((item) => item.id === draft.id))
            continue;
        if (!client.draftPushState.has(draft.id)) {
            client.draftPushState.set(draft.id, {
                allowAutoSend: false,
                skipped: false,
                reason: 'not_latest_unreplied'
            });
        }
    }

    for (const draft of draftsToPush) {
        if (draft.status === 'sent' || draft.status === 'dispatching')
            continue;
        // 页面/库里已确认同文发出：永久跳过，避免切回话又点一次。
        if (draft.alreadyReplied === true) {
            if (!client.draftPushState.has(draft.id)) {
                client.draftPushState.set(draft.id, {
                    allowAutoSend: false,
                    skipped: true,
                    reason: 'already_replied'
                });
            }
            continue;
        }

        const previousPush = client.draftPushState.get(draft.id);
        // expected 全空时的兜底候选也视为「当前该回」，否则永远 session_not_authorized 只回填或跳过。
        const isExpectedMessage = client.expectedMessageIds.has(draft.messageId)
            || recentOrphanRescue.some((item) => item.id === draft.id)
            || (client.expectedMessageIds.size === 0 && candidates.some((item) => item.id === draft.id));
        const cooldownPassed = hasPlatformCooldownPassed(client, session.platform);
        const allowPlatformRpaAutoSend = isRpaCustomerAllowed(session);
        let { allowAutoSend, denyReason } = resolveAutoSendDecision({
            client,
            draft,
            isExpectedMessage,
            allowPlatformRpaAutoSend,
            cooldownPassed
        });

        // 本可自动发送，只是冷却未到：先不推也不烧 expected，等下一轮。
        if (denyReason === 'platform_cooldown')
            continue;

        // 切回话回扫 / 孤儿兜底：曾经推过就不允许再自动发送。
        if (shouldSkipDueToPreviousPush(previousPush, allowAutoSend))
            continue;

        pushDraftFrame(client, session, draft, allowAutoSend, denyReason, isExpectedMessage);
    }
}

/**
 * 定时入口：遍历本连接所有会话推草稿。
 * pollingDrafts 防重入；settingsReady 未就绪不推（避免首轮按 fill_only 烧掉可自动发送的稿）。
 */
async function readDrafts(client, apiBaseUrl) {
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
                // 白名单变更：摘掉非测试会话，防误回正式客户。
                for (const key of [session.conversationId, session.customerName, session.customerId].filter(Boolean))
                    client.sessions.delete(`${session.platform}:${key}`);
                continue;
            }
            if (!client.settingsReady)
                continue;

            await pollAndPushSessionDrafts(client, session, apiBaseUrl);
        }
    }
    finally {
        client.pollingDrafts = false;
    }
}

// ---------------------------------------------------------------------------
// 会话登记与 inbound 期望对齐
// ---------------------------------------------------------------------------

/** 登记到轮询表（多 key：conversationId / 昵称 / customerId）。 */
function registerClientSession(client, session) {
    if (!session?.platform || !isRpaCustomerAllowed(session))
        return;
    const keys = new Set([session.conversationId, session.customerName, session.customerId].filter(Boolean));
    if (!keys.size)
        return;
    for (const key of keys)
        client.sessions.set(`${session.platform}:${key}`, session);
}

/** 按会话清理 expected（仅重连等显式场景调用；连发过程中不要清）。 */
function clearExpectedForConversation(client, conversationId) {
    if (!conversationId)
        return;
    for (const existingId of [...client.expectedMessageIds]) {
        const sameConversation = String(existingId).startsWith(`${conversationId}:`)
            || client.expectedMessageMeta?.get?.(existingId) === conversationId;
        if (sameConversation) {
            client.expectedMessageIds.delete(existingId);
            client.expectedMessageMeta?.delete?.(existingId);
        }
    }
}

/**
 * inbound 到达时先乐观登记 expected，再 await 入库。
 * Worker 可能比 ACK 更快出草稿；若等 API 返回才登记，会被轮询漏推。
 *
 * 同客户连发：追加 expected，不清空同会话旧 id。
 * 自动发送按 createdAt 升序 FIFO 推，保证多条都会回，而不是只回最新一条。
 */
function registerOptimisticInbound(client, payload) {
    const optimisticInboundId = String(payload.id);
    const conversationId = String(payload.conversationId || '');
    client.expectedMessageIds.add(optimisticInboundId);
    if (!client.expectedMessageMeta)
        client.expectedMessageMeta = new Map();
    client.expectedMessageMeta.set(optimisticInboundId, conversationId);
    registerClientSession(client, {
        platform: payload.platform,
        shopId: payload.shopId,
        conversationId: payload.conversationId,
        customerId: payload.customerId,
        customerName: payload.customerName,
        pageUrl: payload.pageUrl || ''
    });
    return optimisticInboundId;
}

/**
 * 入库结果回来后对齐 expected：
 * - HTTP 失败 → 撤销乐观登记
 * - duplicated / 成功：保留；若返回真实 messageId 不同则换成库内 id
 *   （切勿因 duplicated 删 expected，否则会出现 pending>0 且 expected=0）
 */
function alignExpectedAfterInbound(client, optimisticInboundId, response, result, conversationId) {
    if (!optimisticInboundId)
        return;
    if (!response.ok) {
        client.expectedMessageIds.delete(optimisticInboundId);
        client.expectedMessageMeta?.delete?.(optimisticInboundId);
        return;
    }
    const realId = result?.messageId || result?.message?.id;
    if (!realId || String(realId) === optimisticInboundId)
        return;
    client.expectedMessageIds.delete(optimisticInboundId);
    client.expectedMessageMeta?.delete?.(optimisticInboundId);
    client.expectedMessageIds.add(String(realId));
    client.expectedMessageMeta?.set?.(String(realId), String(conversationId || ''));
}

// ---------------------------------------------------------------------------
// 扩展事件处理
// ---------------------------------------------------------------------------

/** 插件回报点击/回填结果：成功则 mark-dispatched；失败则标 clickFailed 供冷却重推。 */
async function handleDraftSendResult(client, apiBaseUrl, payload) {
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
    if (!payload.draftId)
        return;

    if (payload.clicked === true) {
        client.draftPushState.set(payload.draftId, {
            allowAutoSend: true,
            clicked: true,
            skipped: true,
            reason: 'client_clicked',
            pushedAt: Date.now()
        });
        try {
            const response = await fetch(
                new URL(`/reply-drafts/${payload.draftId}/mark-dispatched`, apiBaseUrl),
                { method: 'POST' }
            );
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
        }
        catch (error) {
            terminalLog('warn', {
                platform: payload.platform,
                customer: payload.customerName || payload.customerId || payload.conversationId,
                denyReason: 'mark_dispatched_failed',
                content: error instanceof Error ? error.message : String(error)
            });
        }
        return;
    }

    // 服务端授权自动发送但插件没点到 → 允许冷却后重推。
    if (payload.allowAutoSend === true) {
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

/**
 * 切回话回来找回草稿：清掉「未点成功」的推送壁垒，允许把 pending 再推一次。
 * 已确认点击 / already_replied 的仍保留，防止重复发送。
 */
function clearPushBarriersForRecoverableDrafts(client, drafts) {
    for (const draft of drafts ?? []) {
        const previous = client.draftPushState.get(draft.id);
        client.draftPushState.delete(`warn:${draft.id}`);
        if (!previous)
            continue;
        if (previous.clicked === true || previous.reason === 'client_clicked' || previous.reason === 'already_replied')
            continue;
        client.draftPushState.delete(draft.id);
    }
}

/**
 * 扩展 → 网关事件分发。
 * 浏览器不能指定任意后端 URL；只处理白名单 message.type。
 */
async function handleMessage(client, apiBaseUrl, raw) {
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
            sendFrame(client.socket, {
                type: 'ignored_session',
                payload: { reason: 'customer_not_allowed', session: message.payload }
            });
            return;
        }
        registerClientSession(client, message.payload);
        sendFrame(client.socket, {
            type: 'connected',
            payload: { clientId: client.id, ...buildRpaAllowlistStatus() }
        });
        // 重连/切回会话后立刻拉一次：覆盖「Worker 先出稿、session 后登记」和 Redis 残留任务。
        if (client.settingsReady)
            void pollAndPushSessionDrafts(client, message.payload, apiBaseUrl);
        return;
    }

    if (message.type === 'request_drafts') {
        // 页面检测到待回复尾巴：有现成 pending 草稿就推回来发送，不必重新生成。
        if (!isRpaCustomerAllowed(message.payload))
            return;
        if (!client.settingsReady)
            return;
        registerClientSession(client, message.payload);
        const preview = await fetchRecentDrafts(message.payload, apiBaseUrl);
        const recoverable = (preview.drafts ?? []).filter((draft) => ['pending', 'approved'].includes(draft.status)
            && draft.alreadyReplied !== true);
        clearPushBarriersForRecoverableDrafts(client, recoverable);
        if (recoverable.length > 0) {
            terminalLog('warn', {
                platform: message.payload.platform,
                customer: message.payload.customerName || message.payload.customerId || message.payload.conversationId,
                denyReason: 'recover_pending_draft',
                content: `找回pending=${recoverable.length} reason=${message.payload.reason || 'refocus'}`
            });
        }
        await pollAndPushSessionDrafts(client, message.payload, apiBaseUrl);
        return;
    }

    if (message.type === 'reset_sessions') {
        // 扩展重连：清旧 frame 与 expected，避免历史占位会话误路由。
        client.sessions.clear();
        client.expectedMessageIds.clear();
        client.expectedMessageMeta?.clear?.();
        return;
    }

    if (message.type === 'remove_session') {
        // 离开某会话时摘掉轮询 key。
        // 不清 expected：同客户连发时短暂切到别人再回来，仍要按队列把未回的草稿推完。
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
        // 弹窗「自动发送」同步到本连接；断线后须由扩展从 storage 再发。
        const nextEnabled = message.payload?.autoSendEnabled === true;
        const wasReady = client.settingsReady;
        if (nextEnabled && !client.autoSendEnabled)
            client.autoSendEnabledAt = Date.now();
        client.autoSendEnabled = nextEnabled;
        client.settingsReady = true;
        // 首次 settings 就绪立刻扫会话草稿，减少抖音页「有稿不推」等待。
        if (!wasReady)
            void readDrafts(client, apiBaseUrl);
        return;
    }

    if (message.type === 'diagnostics') {
        // 只收选择器命中结构，不收聊天正文。
        client.diagnostics.set(message.payload.pageUrl, message.payload);
        return;
    }

    if (message.type === 'draft_send_result') {
        await handleDraftSendResult(client, apiBaseUrl, message.payload ?? {});
        return;
    }

    if (!['inbound', 'outbound'].includes(message.type))
        return;

    if (!isRpaCustomerAllowed(message.payload)) {
        // 非白名单：不入库、不排队、不推草稿。
        sendFrame(client.socket, {
            type: `${message.type}_ack`,
            requestId: message.requestId,
            payload: { ok: true, ignored: true, reason: 'customer_not_allowed' }
        });
        return;
    }

    const endpoint = message.type === 'outbound' ? '/rpa/outbound' : '/rpa/inbound';
    let optimisticInboundId = '';
    if (message.type === 'inbound' && message.payload?.id)
        optimisticInboundId = registerOptimisticInbound(client, message.payload);

    const response = await fetch(new URL(endpoint, apiBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(message.payload)
    });
    const result = await response.json().catch(() => ({ ok: false }));

    if (message.type === 'inbound') {
        alignExpectedAfterInbound(
            client,
            optimisticInboundId,
            response,
            result,
            message.payload?.conversationId
        );
    }

    sendFrame(client.socket, {
        type: response.ok ? `${message.type}_ack` : 'error',
        requestId: message.requestId,
        payload: result
    });
}

// ---------------------------------------------------------------------------
// 连接生命周期
// ---------------------------------------------------------------------------

function createClientState(socket) {
    return {
        id: crypto.randomUUID(),
        socket,
        buffer: Buffer.alloc(0),
        /** platform:key → 会话，供草稿轮询 */
        sessions: new Map(),
        /** pageUrl → 选择器诊断（无聊天正文） */
        diagnostics: new Map(),
        /** 弹窗「允许自动点击发送」 */
        autoSendEnabled: false,
        autoSendEnabledAt: Number.POSITIVE_INFINITY,
        /** 是否已收到 client_settings；未就绪不推草稿 */
        settingsReady: false,
        connectedAt: Date.now(),
        /** 轮询重入锁 */
        pollingDrafts: false,
        lastAutoSendAt: 0,
        /** 按平台分开的自动发送冷却时间戳 */
        lastAutoSendAtByPlatform: new Map(),
        /** draftId → 推送/点击状态（防重复下发） */
        draftPushState: new Map(),
        /** 当前期望回复的入站 messageId（与草稿 messageId 对齐） */
        expectedMessageIds: new Set(),
        /** messageId → conversationId，用于同会话清理旧 expected */
        expectedMessageMeta: new Map()
    };
}

/**
 * 在 Fastify HTTP Server 上挂载本机 WebSocket（仅 127.0.0.1）。
 * 扩展跑在用户正常 Chrome 里，网关只桥接消息，不碰账号/密码/Cookie。
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

        const client = createClientState(socket);
        clients.add(client);
        sendFrame(socket, {
            type: 'connected',
            payload: { clientId: client.id, ...buildRpaAllowlistStatus() }
        });

        socket.on('data', (chunk) => parseFrames(client, chunk, (raw) => {
            void handleMessage(client, apiBaseUrl, raw).catch((error) => {
                sendFrame(socket, {
                    type: 'error',
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }));
        socket.on('close', () => clients.delete(client));
        socket.on('error', () => clients.delete(client));
    });

    const timer = setInterval(() => {
        for (const client of clients)
            void readDrafts(client, apiBaseUrl);
    }, DRAFT_POLL_INTERVAL_MS);
    timer.unref();
}

/** 供 /guide、健康检查：连接数、会话、自动发送开关与脱敏诊断。 */
export function getRpaExtensionStatus() {
    return {
        connectedClients: clients.size,
        sessions: [...clients].flatMap((client) => [...client.sessions.values()]),
        autoSendClients: [...clients].filter((client) => client.autoSendEnabled).length,
        // 弹窗已开但这里为 false → API 未读到最新 .env，需重启。
        rpaAutoSendEnabled: env.RPA_AUTO_SEND_ENABLED,
        ...buildRpaAllowlistStatus(),
        diagnostics: [...clients].flatMap((client) => [...client.diagnostics.values()])
    };
}

/** 配置页改白名单后推给已连接扩展，免重连。 */
export function broadcastRpaAllowlistUpdate() {
    const payload = buildRpaAllowlistStatus();
    for (const client of clients)
        sendFrame(client.socket, { type: 'connected', payload: { clientId: client.id, ...payload } });
    return payload;
}
