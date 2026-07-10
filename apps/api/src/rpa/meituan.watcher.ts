// @ts-nocheck
/**
 * @file apps/api/src/rpa/meituan.watcher.ts
 * @module RPA 与 Chrome 插件
 * @description 美团 Playwright Adapter 骨架。
 * @see 联动关注：默认推荐使用 Chrome 插件。
 */
import { startDomMessageWatcher } from './dom-message-watcher.js';
import { loadRpaWatcherConfig } from './selector-config.js';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(currentDir, '../../../..');
// 美团到店团购 RPA watcher 骨架。
// 到店团购公开客服 API 不明确，所以第一版先走半自动 RPA。
export async function startMeituanWatcher() {
    const configuredUserDataDir = process.env.MEITUAN_RPA_USER_DATA_DIR
        ?? '.sessions/meituan-production';
    const config = await loadRpaWatcherConfig({
        name: '美团到店 RPA',
        platform: 'meituan',
        url: process.env.MEITUAN_RPA_URL ?? 'https://g.dianping.com/dzim-main-pc/index.html#/',
        // 固定到项目根目录，避免从不同工作目录启动时生成多份登录态而反复登录。
        userDataDir: isAbsolute(configuredUserDataDir)
            ? configuredUserDataDir
            : resolve(projectRoot, configuredUserDataDir),
        apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:3001',
        defaultShopId: process.env.MEITUAN_RPA_SHOP_ID ?? 'default-shop',
        defaultConversationId: process.env.MEITUAN_RPA_CONVERSATION_ID ?? 'meituan-demo-conv',
        defaultCustomerId: process.env.MEITUAN_RPA_CUSTOMER_ID ?? 'meituan-demo-customer',
        contentFrameName: 'chat',
        loginUrlPatterns: [
            'ecom.meituan.com/bizaccount/login',
            'e.dianping.com/slogin'
        ],
        selectors: {
            // TODO: 需在经营宝 chat iframe 内确认真实消息选择器；不要套用外卖/闪购 IM 官方接口。
            messageItem: process.env.MEITUAN_RPA_MESSAGE_ITEM_SELECTOR ?? '[data-rpa-message-item]',
            messageText: process.env.MEITUAN_RPA_MESSAGE_TEXT_SELECTOR ?? '[data-rpa-message-text]',
            messageIdAttribute: process.env.MEITUAN_RPA_MESSAGE_ID_ATTRIBUTE ?? 'data-message-id',
            customerNameAttribute: process.env.MEITUAN_RPA_CUSTOMER_NAME_ATTRIBUTE ?? 'data-customer-name',
            createdAtAttribute: process.env.MEITUAN_RPA_CREATED_AT_ATTRIBUTE ?? 'data-created-at'
        },
        senderSelectors: {
            // 已确认编辑器是 plaintext-only；发送按钮仍需现场确认稳定选择器后才能启用自动发送。
            replyInput: process.env.MEITUAN_RPA_REPLY_INPUT_SELECTOR ?? 'pre[contenteditable="plaintext-only"]',
            sendButton: process.env.MEITUAN_RPA_SEND_BUTTON_SELECTOR ?? '[data-rpa-send-button-not-configured]'
        },
        renderDraftToPage: false
    });
    await startDomMessageWatcher(config);
}
