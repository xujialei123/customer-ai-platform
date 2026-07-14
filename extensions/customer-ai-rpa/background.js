/**
 * @file extensions/customer-ai-rpa/background.js
 * @module RPA 与 Chrome 插件
 * @description WebSocket 连接、设置迁移、多会话路由和断线重连。
 * @see 联动关注：extension-gateway.ts 协议。
 */
importScripts('platform-profiles.js');

const GLOBAL_SETTINGS = {
  settingsVersion: 15,
  enabled: true,
  wsUrl: 'ws://127.0.0.1:3001/rpa/extension/ws',
  autoSwitchConversations: false,
  autoSend: false
};

// 兼容旧版读取逻辑：美团字段仍保留在顶层，避免升级后已有配置丢失。
const DEFAULT_SETTINGS = {
  ...GLOBAL_SETTINGS,
  ...PLATFORM_PROFILES.meituan
};

let socket;
let reconnectTimer;
const sessionTargets = new Map();
const frameSessions = new Map();
const pendingDiagnostics = [];
let connectionState = 'disconnected';

function normalizeDouyinSessionPart(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '');
}

function sessionLookupKeys(session) {
  const keys = new Set();
  if (!session?.platform)
    return [];
  if (session.conversationId)
    keys.add(`${session.platform}:${session.conversationId}`);
  if (session.customerName)
    keys.add(`${session.platform}:${session.customerName}`);
  if (session.customerId && session.customerId !== session.conversationId)
    keys.add(`${session.platform}:${session.customerId}`);
  return [...keys];
}

function resolveDraftTarget(session) {
  for (const key of sessionLookupKeys(session)) {
    const target = sessionTargets.get(key);
    if (target)
      return target;
  }
  if (session?.platform !== 'douyin')
    return null;
  const wanted = normalizeDouyinSessionPart(session.customerName || session.conversationId);
  if (!wanted)
    return null;
  for (const [key, target] of sessionTargets.entries()) {
    if (!key.startsWith('douyin:'))
      continue;
    const registered = normalizeDouyinSessionPart(key.slice('douyin:'.length));
    if (registered && (registered.includes(wanted) || wanted.includes(registered)))
      return target;
  }
  return null;
}

function registerSessionTarget(session, tabId, frameId) {
  const target = { session, tabId, frameId };
  for (const key of sessionLookupKeys(session))
    sessionTargets.set(key, target);
}

function unregisterSessionKeys(keys) {
  for (const key of keys)
    sessionTargets.delete(key);
}

function forwardToServer(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  if (message.type === 'diagnostics')
    pendingDiagnostics.push(message.payload);
  return false;
}

async function reinjectPlatformTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://life.douyin.com/*', 'https://g.dianping.com/*', 'https://ecom.meituan.com/*']
  });
  for (const tab of tabs) {
    if (!tab.id)
      continue;
    await injectAllFrames(tab.id);
    if (/life\.douyin\.com/i.test(tab.url || '')) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        files: ['douyin-main-click.js']
      }).catch(() => undefined);
    }
    chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => undefined);
  }
}

async function migrateSettings(saved) {
  const profiles = { ...(saved.platformProfiles || {}) };
  profiles.meituan = {
    ...PLATFORM_PROFILES.meituan,
    shopId: saved.shopId || profiles.meituan?.shopId,
    messageItemSelector: saved.messageItemSelector === '[data-rpa-message-item]'
      ? PLATFORM_PROFILES.meituan.messageItemSelector
      : (saved.messageItemSelector || profiles.meituan?.messageItemSelector),
    messageTextSelector: saved.messageTextSelector === '[data-rpa-message-text]'
      ? PLATFORM_PROFILES.meituan.messageTextSelector
      : (saved.messageTextSelector || profiles.meituan?.messageTextSelector),
    replyInputSelector: saved.replyInputSelector === 'pre[contenteditable="plaintext-only"]'
      ? PLATFORM_PROFILES.meituan.replyInputSelector
      : (saved.replyInputSelector || profiles.meituan?.replyInputSelector),
    sendButtonSelector: !saved.sendButtonSelector
      || saved.sendButtonSelector.includes('not-configured')
      || saved.sendButtonSelector === '[data-rpa-send-button]'
      ? PLATFORM_PROFILES.meituan.sendButtonSelector
      : (saved.sendButtonSelector || profiles.meituan?.sendButtonSelector),
    conversationItemSelector: !saved.conversationItemSelector || saved.conversationItemSelector === '.chat-list-item'
      ? PLATFORM_PROFILES.meituan.conversationItemSelector
      : (saved.conversationItemSelector || profiles.meituan?.conversationItemSelector),
    conversationUnreadSelector: !saved.conversationUnreadSelector || saved.conversationUnreadSelector === '.mtd-badge'
      ? PLATFORM_PROFILES.meituan.conversationUnreadSelector
      : (saved.conversationUnreadSelector || profiles.meituan?.conversationUnreadSelector),
    allowedCustomerIds: profiles.meituan?.allowedCustomerIds ?? saved.allowedCustomerIds ?? ''
  };
    profiles.douyin = {
    ...PLATFORM_PROFILES.douyin,
    ...profiles.douyin,
    customerNameSelector: PLATFORM_PROFILES.douyin.customerNameSelector,
    messageItemSelector: PLATFORM_PROFILES.douyin.messageItemSelector,
    messageTextSelector: PLATFORM_PROFILES.douyin.messageTextSelector,
    outboundMessageItemSelector: PLATFORM_PROFILES.douyin.outboundMessageItemSelector,
    outboundMessageTextSelector: PLATFORM_PROFILES.douyin.outboundMessageTextSelector,
    replyInputSelector: PLATFORM_PROFILES.douyin.replyInputSelector,
    sendButtonSelector: PLATFORM_PROFILES.douyin.sendButtonSelector,
    conversationItemSelector: PLATFORM_PROFILES.douyin.conversationItemSelector,
    conversationUnreadSelector: PLATFORM_PROFILES.douyin.conversationUnreadSelector
  };
  const migrated = {
    ...saved,
    ...GLOBAL_SETTINGS,
    settingsVersion: GLOBAL_SETTINGS.settingsVersion,
    platformProfiles: profiles,
    ...profiles.meituan
  };
  await chrome.storage.local.set(migrated);
  return migrated;
}

async function getSettings() {
  const saved = await chrome.storage.local.get();
  if (Number(saved.settingsVersion ?? 0) < GLOBAL_SETTINGS.settingsVersion)
    return migrateSettings({ ...DEFAULT_SETTINGS, ...saved });
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
  if (settings.enabled === false)
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
    for (const payload of pendingDiagnostics.splice(0, pendingDiagnostics.length))
      send({ type: 'diagnostics', payload });
    void reinjectPlatformTabs();
  });
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'draft') {
      // 服务端会带回会话标识，扩展按注册时的 tab/frame 精确投递，避免多客户并发时串话。
      const target = resolveDraftTarget(message.session);
      if (target)
        chrome.tabs.sendMessage(target.tabId, {
          type: 'applyDraft',
          session: message.session,
          payload: message.payload
        }, { frameId: target.frameId }).catch(() => undefined);
    }
    if (message.type === 'connected') {
      const profiles = { ...(await chrome.storage.local.get('platformProfiles')).platformProfiles || {} };
      // 必须用 Array.isArray：空数组表示「允许全部」，也要写回，否则会继续沿用旧白名单。
      if (Array.isArray(message.payload?.meituanAllowedCustomers)) {
        profiles.meituan = {
          ...PLATFORM_PROFILES.meituan,
          ...profiles.meituan,
          allowedCustomerIds: message.payload.meituanAllowedCustomers.join(',')
        };
      }
      if (Array.isArray(message.payload?.douyinAllowedCustomers)) {
        profiles.douyin = {
          ...PLATFORM_PROFILES.douyin,
          ...profiles.douyin,
          allowedCustomerIds: message.payload.douyinAllowedCustomers.join(',')
        };
      } else {
        profiles.douyin = {
          ...PLATFORM_PROFILES.douyin,
          ...profiles.douyin,
          allowedCustomerIds: profiles.douyin?.allowedCustomerIds ?? ''
        };
      }
      if (Object.keys(profiles).length)
        await chrome.storage.local.set({ platformProfiles: profiles });
    }
  });
  socket.addEventListener('close', () => {
    setState('disconnected');
    reconnectTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => setState('error', '无法连接本地 API，请确认 pnpm dev 已启动'));
}

function send(message) {
  forwardToServer(message);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // tabId + frameId 表示消息来自哪个页面上下文，切换客户时据此撤销旧会话，避免草稿串线。
  if (message.type === 'session') {
    const key = `${message.payload.platform}:${message.payload.conversationId}`;
    const frameKey = `${sender.tab?.id ?? 'unknown'}:${sender.frameId ?? 0}`;
    const previousKey = frameSessions.get(frameKey);
    if (previousKey && previousKey !== key) {
      const previous = sessionTargets.get(previousKey);
      if (previous) {
        send({ type: 'remove_session', payload: previous.session });
        unregisterSessionKeys(sessionLookupKeys(previous.session));
      }
    }
    frameSessions.set(frameKey, key);
    registerSessionTarget(message.payload, sender.tab?.id, sender.frameId ?? 0);
    // 门店 ID 来自经营宝当前会话埋点；同步到存储后弹窗和后续消息使用同一个真实值。
    if (message.payload.shopId && message.payload.shopId !== 'default-shop') {
      if (message.payload.platform === 'douyin') {
        chrome.storage.local.get('platformProfiles').then((stored) => {
          const profiles = stored.platformProfiles || {};
          profiles.douyin = { ...PLATFORM_PROFILES.douyin, ...profiles.douyin, shopId: message.payload.shopId };
          chrome.storage.local.set({ platformProfiles: profiles, detectedShopId: message.payload.shopId });
        });
      } else {
        chrome.storage.local.set({ shopId: message.payload.shopId, detectedShopId: message.payload.shopId });
      }
    }
    send({ type: 'hello', payload: message.payload });
  }
  if (message.type === 'clearFrameSession') {
    // 当前 frame 已切到非白名单客户时，清理旧会话映射，避免状态页和草稿投递仍指向上一个测试客户。
    const frameKey = `${sender.tab?.id ?? 'unknown'}:${sender.frameId ?? 0}`;
    const previousKey = frameSessions.get(frameKey);
    if (previousKey) {
      const previous = sessionTargets.get(previousKey);
      if (previous) {
        send({ type: 'remove_session', payload: previous.session });
        unregisterSessionKeys(sessionLookupKeys(previous.session));
      }
      frameSessions.delete(frameKey);
    }
  }
  if (message.type === 'inbound')
    send({ type: 'inbound', requestId: message.requestId, payload: message.payload });
  if (message.type === 'outbound')
    send({ type: 'outbound', requestId: message.requestId, payload: message.payload });
  if (message.type === 'diagnostics')
    forwardToServer({ type: 'diagnostics', payload: message.payload });
  if (message.type === 'draft_send_result')
    send({ type: 'draft_send_result', payload: message.payload });
  if (message.type === 'settingsChanged') {
    socket?.close();
    void connect();
    void reinjectPlatformTabs();
  }
  if (message.type === 'getStatus')
    sendResponse({ state: connectionState, sessionCount: sessionTargets.size, sessions: [...sessionTargets.values()].map((item) => item.session) });
  if (message.type === 'douyinMainClick') {
    const tabId = sender.tab?.id;
    if (!tabId)
      return;
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      files: ['douyin-main-click.js']
    }).then(() => chrome.scripting.executeScript({
      target: { tabId, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      func: (nameHint) => globalThis.__customerAiClickDouyinCard?.(nameHint),
      args: [message.nameHint || '']
    })).catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }
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
  void reinjectPlatformTabs();
});
chrome.runtime.onStartup.addListener(() => {
  // 浏览器重启后 Service Worker 是全新进程，必须主动恢复 WebSocket，而不能等待用户打开扩展。
  chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
  void connect();
  void reinjectPlatformTabs();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rpa-reconnect' && socket?.readyState !== WebSocket.OPEN)
    void connect();
});
async function injectAllFrames(tabId) {
  // 经营宝使用动态 frame 和 Shadow DOM，主动注入用于补充静态 content_scripts 可能漏掉的子页面。
  try {
    // 经营宝聊天区由动态 iframe 承载，按 frameId 主动注入可以覆盖 blob/about:blank 等静态规则漏掉的页面。
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['platform-profiles.js', 'content.js'] });
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
  if (!/^https:\/\/g\.dianping\.com\//.test(details.url) && !/^https:\/\/life\.douyin\.com\//.test(details.url))
    return;
  // 聊天 iframe 在顶层页面完成后才动态创建，必须在每个子 frame 自己完成时按 frameId 注入。
  chrome.scripting.executeScript({
    target: { tabId: details.tabId, frameIds: [details.frameId] },
    files: ['platform-profiles.js', 'content.js']
  }).catch(() => undefined);
  if (/^https:\/\/life\.douyin\.com\//.test(details.url)) {
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'MAIN',
      files: ['douyin-main-click.js']
    }).catch(() => undefined);
  }
  void reportFrameMap(details.tabId);
});

setInterval(() => send({ type: 'heartbeat' }), 20000);
// 兼容从旧版本直接“重新加载”扩展但不触发 onInstalled 的情况。
chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
void connect();
