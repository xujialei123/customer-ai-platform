// @ts-nocheck
/**
 * @file apps/api/src/rpa/douyin.watcher.ts
 * @module RPA 与 Chrome 插件
 * @description 抖音 Playwright Adapter 骨架。
 * @see 联动关注：真实接口未确认，保留 TODO。
 */
import { startDomMessageWatcher } from './dom-message-watcher.js';
import { loadRpaWatcherConfig } from './selector-config.js';
// 抖音来客 RPA watcher 骨架。
// 优先方向：监听 WebSocket / XHR，其次读取 DOM，最后才考虑截图识别。
export async function startDouyinWatcher() {
    const config = await loadRpaWatcherConfig({
        name: '抖音来客 RPA',
        platform: 'douyin',
        url: process.env.DOUYIN_RPA_URL ?? 'https://life.douyin.com/',
        userDataDir: '.sessions/douyin',
        apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:3001',
        defaultShopId: process.env.DOUYIN_RPA_SHOP_ID ?? 'default-shop',
        defaultConversationId: process.env.DOUYIN_RPA_CONVERSATION_ID ?? 'douyin-demo-conv',
        defaultCustomerId: process.env.DOUYIN_RPA_CUSTOMER_ID ?? 'douyin-demo-customer',
        selectors: {
            // TODO: 替换为抖音来客真实客服消息 DOM 选择器；优先补 XHR/WebSocket 监听。
            messageItem: process.env.DOUYIN_RPA_MESSAGE_ITEM_SELECTOR ?? '[data-rpa-message-item]',
            messageText: process.env.DOUYIN_RPA_MESSAGE_TEXT_SELECTOR ?? '[data-rpa-message-text]',
            messageIdAttribute: process.env.DOUYIN_RPA_MESSAGE_ID_ATTRIBUTE ?? 'data-message-id',
            customerNameAttribute: process.env.DOUYIN_RPA_CUSTOMER_NAME_ATTRIBUTE ?? 'data-customer-name',
            createdAtAttribute: process.env.DOUYIN_RPA_CREATED_AT_ATTRIBUTE ?? 'data-created-at'
        },
        renderDraftToPage: false
    });
    await startDomMessageWatcher(config);
}
