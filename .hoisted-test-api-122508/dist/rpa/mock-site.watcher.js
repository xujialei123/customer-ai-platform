// @ts-nocheck
import { startDomMessageWatcher } from './dom-message-watcher.js';
const platform = process.env.RPA_PLATFORM === 'meituan' ? 'meituan' : 'douyin';
const mockUrl = process.env.RPA_MOCK_URL ?? `http://127.0.0.1:3100/?platform=${platform}`;
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3001';
async function main() {
    // mock watcher 固定使用本地测试页配置，不能读取真实抖音/美团 selector example。
    // 否则本地测试会被错误导向真实平台 URL，导致没有账号时一直轮询失败。
    await startDomMessageWatcher({
        name: `${platform} mock RPA`,
        platform,
        url: mockUrl,
        userDataDir: `.sessions/mock-${platform}`,
        apiBaseUrl,
        defaultShopId: 'shop-demo',
        defaultConversationId: `${platform}-mock-conv-001`,
        defaultCustomerId: `${platform}-mock-user-001`,
        selectors: {
            messageItem: '.msg.inbound[data-message-id]',
            messageText: '.content',
            messageIdAttribute: 'data-message-id',
            customerNameAttribute: 'data-customer-name',
            createdAtAttribute: 'data-created-at'
        },
        pageDataset: {
            platform: 'platform',
            shopId: 'shopId',
            conversationId: 'conversationId',
            customerId: 'customerId'
        },
        senderSelectors: {
            replyInput: '[data-rpa-reply-input]',
            sendButton: '[data-rpa-send-button]'
        },
        renderDraftToPage: true
    });
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
