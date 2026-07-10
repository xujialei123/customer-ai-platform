// @ts-nocheck
/**
 * @file apps/api/src/rpa/dom-message-watcher.ts
 * @module RPA 与 Chrome 插件
 * @description 旧 Playwright DOM 消息监听和自动发送。
 * @see 联动关注：不能与默认 Chrome 插件重复运行。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { askRagService, createMessageHash } from '@customer-ai/rpa-sdk';
import { createPersistentBrowserContext } from './browser.js';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
// watcher 是独立 tsx 子进程，不会自动复用 API 的 env.ts。
// 这里显式按 UTF-8 读取根目录 .env，确保 RPA_AUTO_SEND_ENABLED 等中文 Windows 环境也能稳定生效。
loadDotEnv({
    path: resolve(currentDir, '../../../../.env'),
    encoding: 'utf8'
});
// 把 RPA 抓到的页面消息投递到统一入口。
// RPA 层只做“采集”，AI 回复、风控、去重都交给后端统一链路，避免不同平台各自实现一套客服逻辑。
async function postInbound(apiBaseUrl, payload) {
    const response = await fetch(`${apiBaseUrl}/rpa/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`投递 RPA 消息失败：${response.status} ${text}`);
    }
    return response.json();
}
async function queryOrderReply(apiBaseUrl, message) {
    const response = await fetch(`${apiBaseUrl}/orders/chat-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message })
    });
    if (!response.ok) {
        throw new Error(`订单聊天查询失败：HTTP ${response.status}`);
    }
    return response.json();
}
// 查询当前会话的新回复草稿。
// 对真实平台而言这里是“建议回复来源”；对 mock 页面而言则用于把 OpenClaw 结果回显出来做闭环测试。
async function fetchReplyDrafts(apiBaseUrl, pageState) {
    const url = new URL(`${apiBaseUrl}/reply-drafts/recent`);
    url.searchParams.set('platform', pageState.platform);
    url.searchParams.set('conversationId', pageState.conversationId);
    url.searchParams.set('limit', '20');
    const response = await fetch(url);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`读取回复草稿失败：${response.status} ${text}`);
    }
    const body = await response.json();
    return (body.drafts ?? []).filter((draft) => draft.status !== 'sent');
}
async function markDraftSent(apiBaseUrl, draftId) {
    const response = await fetch(`${apiBaseUrl}/reply-drafts/${draftId}/mark-sent`, {
        method: 'POST'
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`标记 RPA 草稿已发送失败：${response.status} ${text}`);
    }
}
// 从页面 DOM 中提取统一消息所需的最小字段。
// 选择器来自配置，字段缺失时使用默认值，保证页面局部改版时不会直接打断整个 watcher。
async function extractPageState(page, config) {
    // 这里使用字符串形式的 page.evaluate，避免 tsx/esbuild 给函数注入 __name helper。
    // 注入的 helper 在浏览器上下文不存在，会导致 watcher 持续报 ReferenceError。
    const serializedConfig = JSON.stringify(config);
    return page.evaluate(`(() => {
    const input = ${serializedConfig};
    const body = document.body;
    const dataset = body.dataset;
    const itemSelector = input.selectors.messageItem;
    const textSelector = input.selectors.messageText;

    const readDataset = (key, fallback) => {
      if (!key) return fallback;
      return dataset[key] ?? fallback;
    };

    const messages = Array.from(document.querySelectorAll(itemSelector)).map((item, index) => {
      const idAttribute = input.selectors.messageIdAttribute ?? 'data-message-id';
      const customerNameAttribute = input.selectors.customerNameAttribute ?? 'data-customer-name';
      const createdAtAttribute = input.selectors.createdAtAttribute ?? 'data-created-at';
      const content = item.querySelector(textSelector)?.textContent?.trim() ?? item.textContent?.trim() ?? '';
      const fallbackId = input.defaultConversationId + ':' + index + ':' + content;

      return {
        // 平台页面不一定暴露稳定 messageId，兜底 ID 用会话 + 序号 + 文本，至少能在本次进程内去重。
        id: item.getAttribute(idAttribute) ?? fallbackId,
        customerName: item.getAttribute(customerNameAttribute) ?? undefined,
        createdAt: item.getAttribute(createdAtAttribute) ?? undefined,
        content
      };
    });

    return {
      platform: readDataset(input.pageDataset?.platform, input.platform),
      shopId: readDataset(input.pageDataset?.shopId, input.defaultShopId),
      conversationId: readDataset(input.pageDataset?.conversationId, input.defaultConversationId),
      customerId: readDataset(input.pageDataset?.customerId, input.defaultCustomerId),
      messages
    };
  })()`);
}
async function sendDraftByBrowser(page, config, draft) {
    if (!config.senderSelectors)
        return false;
    const autoSendEnabled = String(process.env.RPA_AUTO_SEND_ENABLED ?? '').toLowerCase() === 'true';
    if (!autoSendEnabled)
        return false;
    if (draft.riskLevel === 'high') {
        return false;
    }
    // mock sender 也走真实浏览器操作：定位输入框、填入回复、点击发送。
    // 后续接真实抖音/美团时，只需要把 senderSelectors 换成真实页面的输入框和发送按钮。
    await page.locator(config.senderSelectors.replyInput).fill(draft.content);
    await page.locator(config.senderSelectors.sendButton).click();
    return true;
}
async function renderRagReplyToMockPage(page, input) {
    // mock 页面不是正式平台，只用于把 RAG 建议回复回显出来做闭环调试。
    // 这里直接追加气泡，不走真实发送按钮，避免和 RPA_AUTO_SEND_ENABLED 的安全语义混在一起。
    const serializedReply = JSON.stringify(input);
    await page.evaluate(`(() => {
    const reply = ${serializedReply};
    const messages = document.querySelector('#messages');
    if (!messages) return;

    const item = document.createElement('article');
    item.className = reply.needHuman ? 'msg outbound warning' : 'msg outbound';
    item.setAttribute('data-rag-reply-id', crypto.randomUUID());
    item.innerHTML = '<div class="meta"></div><div class="content"></div>';

    const meta = item.querySelector('.meta');
    const content = item.querySelector('.content');
    if (meta) meta.textContent = reply.needHuman ? '建议转人工' : 'AI 建议回复';
    if (content) content.textContent = reply.content;

    const reason = normalizeReason(reply.reason);
    if (reason) {
      const reasonNode = document.createElement('div');
      reasonNode.className = 'reason';
      reasonNode.textContent = reason;
      item.appendChild(reasonNode);
    }

    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;

    function normalizeReason(value) {
      if (!value) return '';
      const text = String(value);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|network|RAG|API|HTTP/i.test(text)) {
        return '服务暂时不可用，建议人工接待';
      }
      if (/知识库|检索|向量|模型|RAG/i.test(text)) {
        return '';
      }
      return text;
    }
  })()`);
}
export async function startDomMessageWatcher(config) {
    const context = await createPersistentBrowserContext(config.userDataDir);
    const page = await context.newPage();
    // 所有 RPA 平台先通过同一套 DOM 抓取管线处理。
    // 真实抖音/美团接入时，只替换 URL 和选择器，不改变消息入库、RAG、风控链路。
    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    await waitForPlatformReady(page, config);
    console.log(`${config.name} 已连接：${config.url}`);
    console.log(`${config.name} 抓到新客户消息后会投递到：${config.apiBaseUrl}/rpa/inbound`);
    const seen = new Set();
    const displayedDrafts = new Set();
    let latestPageState = null;
    setInterval(async () => {
        try {
            const contentPage = getContentPage(page, config);
            const pageState = await extractPageState(contentPage, config);
            latestPageState = pageState;
            for (const message of pageState.messages) {
                const hash = createMessageHash(pageState.platform, pageState.shopId, pageState.conversationId, message.content);
                // 使用内存集合做轻量去重；数据库还会按 message.id 二次去重，避免 watcher 重启或页面闪动造成重复处理。
                if (!message.id || seen.has(hash) || !message.content)
                    continue;
                seen.add(hash);
                if (!config.renderDraftToPage) {
                    const result = await postInbound(config.apiBaseUrl, {
                        platform: pageState.platform,
                        id: message.id,
                        shopId: pageState.shopId,
                        conversationId: pageState.conversationId,
                        customerId: pageState.customerId,
                        customerName: message.customerName,
                        content: message.content,
                        createdAt: message.createdAt
                    });
                    console.log(`${config.name} 已投递客户消息：`, { content: message.content, result });
                }
                // 订单问题优先调用公司真实订单系统；普通问题才进入 8787 RAG 服务。
                // 这样订单事实不会被普通知识库回答覆盖，也不会让模型猜测订单状态。
                const orderReply = await queryOrderReply(config.apiBaseUrl, message.content);
                const ragReply = orderReply.matched
                    ? {
                        answer: orderReply.answer ?? '您好，当前订单系统暂时无法查询，请联系人工客服协助核实。',
                        confidence: orderReply.ok ? 1 : 0,
                        needHuman: Boolean(orderReply.needHuman),
                        shouldReply: orderReply.ok && !orderReply.needHuman,
                        reason: orderReply.needHuman ? '订单查询需要人工处理' : '',
                        retrievedChunks: []
                    }
                    : await askRagService({
                        platform: pageState.platform,
                        shopId: pageState.shopId,
                        sessionId: pageState.conversationId,
                        externalUserId: pageState.customerId,
                        externalUserName: message.customerName,
                        userMessage: message.content
                    });
                // 新 RPA 链路直接从 rag-service 获取建议回复；默认 dryRun 只打印，不触碰真实平台发送按钮。
                console.log(`${config.name} RAG 建议回复：`, {
                    answer: ragReply.answer,
                    confidence: ragReply.confidence,
                    needHuman: ragReply.needHuman,
                    shouldReply: ragReply.shouldReply,
                    reason: ragReply.reason,
                    dryRun: String(process.env.RPA_DRY_RUN ?? 'true').toLowerCase() !== 'false'
                });
                if (config.renderDraftToPage) {
                    await renderRagReplyToMockPage(page, {
                        content: ragReply.answer,
                        needHuman: ragReply.needHuman,
                        reason: ragReply.reason
                    });
                }
            }
        }
        catch (error) {
            console.error(`${config.name} 轮询失败：`, error instanceof Error ? error.message : String(error));
        }
    }, config.pollMs ?? 1200);
    setInterval(async () => {
        try {
            if (!latestPageState)
                return;
            if (config.renderDraftToPage)
                return;
            const drafts = await fetchReplyDrafts(config.apiBaseUrl, latestPageState);
            for (const draft of drafts) {
                // 草稿轮询和消息轮询相互独立，必须单独去重，否则页面刷新或接口重复返回会造成多次回显。
                if (displayedDrafts.has(draft.id))
                    continue;
                displayedDrafts.add(draft.id);
                // 真实平台只有显式开启自动发送且通过风控时才操作浏览器；否则草稿保留给人工审核。
                const sentByBrowser = await sendDraftByBrowser(getContentPage(page, config), config, draft);
                if (sentByBrowser) {
                    await markDraftSent(config.apiBaseUrl, draft.id);
                }
                // 抖音/美团正式 RPA 默认只产出建议草稿，不直接发送，避免测试阶段误触达真实客户。
                console.log(`${config.name} 发现 OpenClaw 回复草稿：`, {
                    content: draft.content,
                    riskLevel: draft.riskLevel,
                    reason: draft.reason,
                    sentByBrowser
                });
            }
        }
        catch (error) {
            console.error(`${config.name} 回复草稿轮询失败：`, error instanceof Error ? error.message : String(error));
        }
    }, config.replyPollMs ?? 1800);
}
/**
 * 真实平台首次运行需要人工登录；persistent context 会保存登录态，后续启动通常可直接进入工作台。
 * 这里只观察 URL，不读取账号、密码或 Cookie，也不会尝试绕过平台登录。
 */
async function waitForPlatformReady(page, config) {
    const patterns = config.loginUrlPatterns ?? [];
    const deadline = Date.now() + 15 * 60 * 1000;
    let prompted = false;
    while (Date.now() < deadline) {
        const frameReady = !config.contentFrameName || Boolean(page.frame({ name: config.contentFrameName }));
        if (frameReady) {
            if (prompted)
                console.log(`${config.name} 已进入聊天工作台，继续启动消息监听。`);
            return;
        }
        if (!prompted) {
            const isLoginPage = patterns.some((pattern) => page.url().includes(pattern));
            console.log(isLoginPage
                ? `${config.name} 尚未登录，请在已打开的专用浏览器窗口完成人工登录。`
                : `${config.name} 正在等待聊天工作台加载；如果页面要求登录，请完成人工登录。`);
            prompted = true;
        }
        await page.waitForTimeout(1000);
    }
    throw new Error(`${config.name} 等待聊天工作台超时，请重新启动 watcher 后登录`);
}
/**
 * 经营宝聊天主体位于动态 Blob iframe 中；每次轮询重新按 frame name 获取，页面刷新后也不会持有失效 Frame。
 */
function getContentPage(page, config) {
    if (!config.contentFrameName)
        return page;
    const frame = page.frame({ name: config.contentFrameName });
    if (!frame)
        throw new Error(`尚未找到聊天 iframe：${config.contentFrameName}`);
    return frame;
}
