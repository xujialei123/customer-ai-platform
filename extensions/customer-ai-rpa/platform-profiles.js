/**
 * @file extensions/customer-ai-rpa/platform-profiles.js
 * @module RPA 与 Chrome 插件
 * @description 美团与抖音来客 DOM 预设；按 URL 合并全局开关与平台选择器。
 * @see 联动关注：content.js、background.js、popup.js。
 */
const PLATFORM_PROFILES = {
  meituan: {
    platform: 'meituan',
    shopId: 'default-shop',
    messageItemSelector: '.message-cell-container:has(.message-wrapper.left-message)',
    messageTextSelector: '.text-message.normal-text',
    outboundMessageItemSelector: '.message-cell-container:has(.message-wrapper.right-message .text-message.shop-text)',
    outboundMessageTextSelector: '.text-message.shop-text',
    replyInputSelector: '.dzim-chat-input-container[contenteditable="plaintext-only"]',
    sendButtonSelector: '.dzim-chat-input-send > button.dzim-button-primary',
    sessionRootSelector: '.user-center[lx-mv]',
    customerNameSelector: '.userinfo-name-show',
    trackingAttribute: 'lx-mv',
    conversationItemSelector: '.chat-list-item-wrapper,.chat-list-item,.virtual-list-item',
    conversationUnreadSelector: '.mtd-badge-text.mtd-badge-position',
    allowedCustomerIds: ''
  },
  douyin: {
    platform: 'douyin',
    shopId: 'default-shop',
    messageItemSelector: '.chatd-message--left .chatd-bubble--other, .chatd-message.chatd-message--left',
    messageTextSelector: '.chatd-bubble--other .chatd-bubble-main div, .chatd-bubble-main div',
    outboundMessageItemSelector: '.chatd-message--right .chatd-bubble-main, .chatd-message.chatd-message--right',
    outboundMessageTextSelector: '.chatd-bubble-main div[style*="pre-wrap"], .chatd-bubble-main div',
    replyInputSelector: '[class*="inputWrapper-"] textarea:not([class*="disabledTextarea"]):not([disabled])',
    sendButtonSelector: '[class*="inputWrapper-"] button[class*="sendBtn-"], button[class*="sendBtn-"]',
    sessionRootSelector: '[class*="chatRoom-"]',
    customerNameSelector: '[class*="topbar-"] [class*="uname-"], [class*="chatRoom-"] [class*="uname-"]',
    trackingAttribute: '',
    conversationItemSelector: '#list-container > [class*="contactCard-"], #list-container [class*="contactCard-"]',
    conversationUnreadSelector: '.life-im-pc-badge-type-danger, .life-im-pc-badge-sup-show, [class*="badge-number-"], .life-im-pc-badge .life-im-pc-badge-text',
    allowedCustomerIds: ''
  }
};

function detectPlatformFromUrl(url) {
  const href = String(url || '');
  if (/life\.douyin\.com/i.test(href))
    return 'douyin';
  if (/g\.dianping\.com|ecom\.meituan\.com/i.test(href))
    return 'meituan';
  if (/127\.0\.0\.1:3100|localhost:3100/i.test(href)) {
    try {
      return new URL(href).searchParams.get('platform') === 'meituan' ? 'meituan' : 'douyin';
    } catch {
      return 'meituan';
    }
  }
  return null;
}

function mergePlatformSettings(stored, platform, url) {
  const resolvedPlatform = platform || detectPlatformFromUrl(url);
  if (!resolvedPlatform)
    return null;
  const profiles = stored.platformProfiles || {};
  const profile = profiles[resolvedPlatform] || {};
  const defaults = PLATFORM_PROFILES[resolvedPlatform] || {};
  const legacyMeituan = resolvedPlatform === 'meituan' ? stored : {};
  const selectorFields = [
    'shopId', 'messageItemSelector', 'messageTextSelector', 'outboundMessageItemSelector',
    'outboundMessageTextSelector', 'replyInputSelector', 'sendButtonSelector', 'sessionRootSelector',
    'customerNameSelector', 'trackingAttribute', 'conversationItemSelector', 'conversationUnreadSelector'
  ];
  const merged = {
    platform: resolvedPlatform,
    enabled: stored.enabled !== false,
    autoSend: stored.autoSend === true,
    autoSwitchConversations: stored.autoSwitchConversations === true,
    wsUrl: stored.wsUrl || 'ws://127.0.0.1:3001/rpa/extension/ws',
    allowedCustomerIds: profile.allowedCustomerIds ?? legacyMeituan.allowedCustomerIds ?? defaults.allowedCustomerIds ?? ''
  };
  for (const field of selectorFields) {
    merged[field] = profile[field] ?? legacyMeituan[field] ?? defaults[field] ?? '';
  }
  return merged;
}

globalThis.__customerAiPlatformProfiles = {
  PLATFORM_PROFILES,
  detectPlatformFromUrl,
  mergePlatformSettings
};
