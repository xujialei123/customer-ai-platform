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
        defaultShopId: `${platform}-mock-shop-001`,
        defaultConversationId: `${platform}-customer-001`,
        defaultCustomerId: `${platform}-customer-001`,
        selectors: {
            messageItem: '.message-cell-container:has(.message-wrapper.left-message)',
            messageText: '.text-message.normal-text',
            messageIdAttribute: 'data-messageid',
            createdAtAttribute: 'data-created-at'
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
