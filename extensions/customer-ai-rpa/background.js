/**
 * @file extensions/customer-ai-rpa/background.js
 * @module RPA 与 Chrome 插件
 * @description WebSocket 连接、设置迁移、多会话路由和断线重连。
 * @see 联动关注：extension-gateway.ts 协议。
 */
const DEFAULT_SETTINGS = {
  // 默认只监听和回填；自动点击发送必须由操作员明确开启，并持久化到 Chrome 扩展存储。
  settingsVersion: 3,
  enabled: true,
  wsUrl: 'ws://127.0.0.1:3001/rpa/extension/ws',
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
  conversationItemSelector: '.chat-list-item',
  conversationUnreadSelector: '.mtd-badge',
  autoSwitchConversations: false,
  autoSend: false
};

let socket;
let reconnectTimer;
const sessionTargets = new Map();
const frameSessions = new Map();
let connectionState = 'disconnected';

async function getSettings() {
  // 配置升级采用兼容迁移，不能覆盖用户已经现场确认的真实 DOM 选择器。
  const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (Number(saved.settingsVersion ?? 0) < DEFAULT_SETTINGS.settingsVersion) {
    // 仅迁移旧版占位选择器；用户以后手工调整过的真实选择器不能被扩展升级覆盖。
    const migrated = {
      ...saved,
      settingsVersion: DEFAULT_SETTINGS.settingsVersion,
      messageItemSelector: saved.messageItemSelector === '[data-rpa-message-item]' ? DEFAULT_SETTINGS.messageItemSelector : saved.messageItemSelector,
      messageTextSelector: saved.messageTextSelector === '[data-rpa-message-text]' ? DEFAULT_SETTINGS.messageTextSelector : saved.messageTextSelector,
      replyInputSelector: saved.replyInputSelector === 'pre[contenteditable="plaintext-only"]' ? DEFAULT_SETTINGS.replyInputSelector : saved.replyInputSelector,
      sendButtonSelector: saved.sendButtonSelector || DEFAULT_SETTINGS.sendButtonSelector
    };
    await chrome.storage.local.set(migrated);
    return migrated;
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

function setState(state, error = '') {
  // 连接状态写入 storage，弹窗关闭后重新打开仍能显示最后一次结果。
  connectionState = state;
  chrome.storage.local.set({ connectionState: state, connectionError: error });
}

async function connect() {
  // Manifest V3 Service Worker 会休眠，连接函数必须可重复调用并避免创建并行 WebSocket。
  clearTimeout(reconnectTimer);
  const settings = await getSettings();
  if (!settings.enabled)
    return setState('disabled');
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState))
    return;
  setState('connecting');
  socket = new WebSocket(settings.wsUrl);
  socket.addEventListener('open', () => {
    setState('connected');
    send({ type: 'client_settings', payload: { autoSendEnabled: settings.autoSend === true } });
    send({ type: 'reset_sessions' });
    for (const { session } of sessionTargets.values())
      send({ type: 'hello', payload: session });
  });
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'draft') {
      // 服务端会带回会话标识，扩展按注册时的 tab/frame 精确投递，避免多客户并发时串话。
      const key = `${message.session.platform}:${message.session.conversationId}`;
      const target = sessionTargets.get(key);
      if (target)
        chrome.tabs.sendMessage(target.tabId, {
          type: 'applyDraft',
          session: message.session,
          payload: message.payload
        }, { frameId: target.frameId }).catch(() => undefined);
    }
  });
  socket.addEventListener('close', () => {
    setState('disconnected');
    reconnectTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => setState('error', '无法连接本地 API，请确认 pnpm dev 已启动'));
}

function send(message) {
  // 断线期间不缓存平台消息，页面扫描器会在重连后按 messageId 再次发现并由数据库去重。
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // tabId + frameId 表示消息来自哪个页面上下文，切换客户时据此撤销旧会话，避免草稿串线。
  if (message.type === 'session') {
    const key = `${message.payload.platform}:${message.payload.conversationId}`;
    const frameKey = `${sender.tab?.id ?? 'unknown'}:${sender.frameId ?? 0}`;
    const previousKey = frameSessions.get(frameKey);
    if (previousKey && previousKey !== key) {
      const previous = sessionTargets.get(previousKey);
      if (previous)
        send({ type: 'remove_session', payload: previous.session });
      sessionTargets.delete(previousKey);
    }
    frameSessions.set(frameKey, key);
    sessionTargets.set(key, { session: message.payload, tabId: sender.tab?.id, frameId: sender.frameId ?? 0 });
    // 门店 ID 来自经营宝当前会话埋点；同步到存储后弹窗和后续消息使用同一个真实值。
    if (message.payload.shopId && message.payload.shopId !== 'default-shop')
      chrome.storage.local.set({ shopId: message.payload.shopId, detectedShopId: message.payload.shopId });
    send({ type: 'hello', payload: message.payload });
  }
  if (message.type === 'inbound')
    send({ type: 'inbound', requestId: message.requestId, payload: message.payload });
  if (message.type === 'outbound')
    send({ type: 'outbound', requestId: message.requestId, payload: message.payload });
  if (message.type === 'diagnostics')
    send({ type: 'diagnostics', payload: message.payload });
  if (message.type === 'settingsChanged') {
    socket?.close();
    void connect();
  }
  if (message.type === 'getStatus')
    sendResponse({ state: connectionState, sessionCount: sessionTargets.size, sessions: [...sessionTargets.values()].map((item) => item.session) });
  if (message.type === 'ensureConnection') {
    void connect();
    sendResponse({ ok: true });
  }
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get();
  // 扩展升级时只补默认字段，保留用户已经选择的自动发送状态和现场 DOM 配置。
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
  await chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  // 浏览器重启后 Service Worker 是全新进程，必须主动恢复 WebSocket，而不能等待用户打开扩展。
  chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rpa-reconnect' && socket?.readyState !== WebSocket.OPEN)
    void connect();
});
async function injectAllFrames(tabId) {
  // 经营宝使用动态 frame 和 Shadow DOM，主动注入用于补充静态 content_scripts 可能漏掉的子页面。
  try {
    // 经营宝聊天区由动态 iframe 承载，按 frameId 主动注入可以覆盖 blob/about:blank 等静态规则漏掉的页面。
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch {
    // 登录页、浏览器内部页或尚未授权的 frame 会拒绝注入，不影响其他已授权经营宝 frame。
  }
}

async function reportFrameMap(tabId) {
  // Frame Map 仅用于排查注入范围，不采集 frame 内聊天内容。
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    send({
      type: 'diagnostics',
      payload: {
        pageUrl: `extension-frame-map://tab/${tabId}`,
        frameTitle: 'Chrome frame map',
        frames: frames.map((frame) => ({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url }))
      }
    });
  } catch {
    // 标签页关闭时无需保留 frame map。
  }
}

chrome.webNavigation.onCompleted.addListener((details) => {
  if (!/^https:\/\/g\.dianping\.com\//.test(details.url))
    return;
  // 聊天 iframe 在顶层页面完成后才动态创建，必须在每个子 frame 自己完成时按 frameId 注入。
  chrome.scripting.executeScript({
    target: { tabId: details.tabId, frameIds: [details.frameId] },
    files: ['content.js']
  }).catch(() => undefined);
  void reportFrameMap(details.tabId);
});

setInterval(() => send({ type: 'heartbeat' }), 20000);
// 兼容从旧版本直接“重新加载”扩展但不触发 onInstalled 的情况。
chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
void connect();
