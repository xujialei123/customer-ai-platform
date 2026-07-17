/**
 * @file extensions/customer-ai-rpa/background.js
 * @module RPA 与 Chrome 插件
 * @description 扩展的「后台中转站」：只负责连接、记账、转发，不操作网页 DOM。
 * @see 联动关注：content.js、platform-profiles.js、apps/api 的 extension-gateway.ts
 *
 * =============================================================================
 * 【先读这段：整条链路按时间走】
 * =============================================================================
 *
 * 角色：
 *   前台网页（美团/抖音） ← content.js（眼睛和手）
 *                              ↕  chrome.runtime 消息
 *                         本文件 background.js（中转）
 *                              ↕  WebSocket
 *                         本机客服中台 :3001（大脑）
 *
 * 启动时（扩展加载 / 浏览器开机）：
 *   ① connect()                 连本机中台
 *   ② reinjectPlatformTabs()    给已打开的平台页塞 content 脚本
 *   ③ alarm 每 ~30s             断了就再 connect()
 *
 * 客户发来一条新消息时：
 *   ④ content.scanMessages      在网页里看见气泡
 *   ⑤ → background「inbound」   本文件转给中台
 *   ⑥ → background「session」   记下：这个客户在哪个标签页
 *   ⑦ 中台 RAG + AI 出草稿
 *   ⑧ 中台 WS 推「draft」
 *   ⑨ resolveDraftTarget()     查对照表：草稿该送给谁
 *  ⑩ → content「applyDraft」    网页里填框 / 点发送
 *  ⑪ → background「draft_send_result」 告诉中台发没发出去
 *
 * 自动切未读客户时：
 *   content 自己点左侧列表；需要时发「douyinMainClick」让本文件在网页环境补点一下。
 *   切到人之后仍走上面的 session → inbound → draft 链路。
 *
 * 切回「还有待回复」的客户时：
 *   content 发「request_drafts」→ 本文件转中台 → 中台把库里已有草稿再推一次（不重跑 AI）。
 *
 * 本文件函数怎么分工（别按字母序读，按上面编号）：
 *   对照表：sessionLookupKeys / registerSessionTarget / resolveDraftTarget
 *   连中台：connect / forwardToServer / send
 *   收页面消息：最下面的 onMessage（session / inbound / draft_send_result …）
 *   保活注入：reinjectPlatformTabs / injectAllFrames / onCompleted
 * =============================================================================
 */
importScripts('platform-profiles.js');

// ---------------------------------------------------------------------------
// 一、默认设置 & 几个全局变量（整份文件共用）
// ---------------------------------------------------------------------------

/**
 * 第一次安装扩展时的默认开关。
 * settingsVersion：以后改默认选择器时把数字 +1，用户升级扩展会自动跑一遍迁移。
 */
const GLOBAL_SETTINGS = {
  settingsVersion: 15,
  enabled: true,
  // 连本机客服中台的地址（不是公网）
  wsUrl: 'ws://127.0.0.1:3001/rpa/extension/ws',
  // 默认不自动切左侧客户，怕选错人
  autoSwitchConversations: false,
  // 默认只把回复填进输入框，不自动点「发送」
  autoSend: false
};

// 旧版把美团选择器存在最外层；升级后仍拷一份在顶层，老弹窗读得到。
const DEFAULT_SETTINGS = {
  ...GLOBAL_SETTINGS,
  ...PLATFORM_PROFILES.meituan
};

/** 跟本机中台之间的长连接（WebSocket）。Chrome 后台睡着后可能断掉，后面有定时重连。 */
let socket;
/** 断开后等几秒再连的定时器，免得连不上时一秒重试几百次。 */
let reconnectTimer;

/**
 * 「客户 → 哪个浏览器标签页」对照表。
 *
 * 例子：记着「抖音:小明」对应 tab 3 的某个小页面。
 * 中台回了「给小明的草稿」时，靠这张表找到该往哪送，不会填到隔壁客户框里。
 */
const sessionTargets = new Map();

/**
 * 「这个小页面现在聊的是谁」。
 *
 * 同一个聊天框切到另一个客户时，要把上一个人从对照表里删掉，
 * 否则旧草稿还可能往新客户身上塞。
 */
const frameSessions = new Map();

/**
 * 还没连上中台时，页面报上来的「诊断信息」先放这里；
 * 连上后再一口气发出去，引导页 /guide 才看得到插件状态。
 */
const pendingDiagnostics = [];

/** 给弹窗看的连接状态：已连接 / 断开 / 出错… */
let connectionState = 'disconnected';

// ---------------------------------------------------------------------------
// 二、怎么找到「回复该送给谁」
// ---------------------------------------------------------------------------

/**
 * 把抖音昵称洗干净：去掉空格、表情。
 * 为什么：页面上叫「小 明😊」，中台草稿里可能是「小明」，不洗就对不上。
 */
function normalizeDouyinSessionPart(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '');
}

/**
 * 一个客户可能有好几个名字（会话 id、昵称、客户 id）。
 * 这里一次生成所有可能的查找键，后面随便用哪一个都能找到。
 */
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

/**
 * 中台发来一份回复时：查对照表，看该送到哪个标签页。
 *
 * - 美团：id 比较稳定，对上就行。
 * - 抖音：内部 id 和左边列表上的昵称经常不是同一个字，
 *   精确对不上时，再试「名字互相包含」模糊找一下。
 */
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

/** 记住：这个客户的回复，要送到这个标签页 / 这个小页面。 */
function registerSessionTarget(session, tabId, frameId) {
  const target = { session, tabId, frameId };
  for (const key of sessionLookupKeys(session))
    sessionTargets.set(key, target);
}

/** 从对照表里删掉若干键（换客户、离开聊天时用）。 */
function unregisterSessionKeys(keys) {
  for (const key of keys)
    sessionTargets.delete(key);
}

/**
 * 把消息发给本机中台。
 * 没连上时：普通业务先放弃（页面稍后会再报）；
 * 诊断信息先存着，连上再补发。
 */
function forwardToServer(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  if (message.type === 'diagnostics')
    pendingDiagnostics.push(message.payload);
  return false;
}

/**
 * 中台刚连上 / 扩展刚醒过来时：
 * 给已经打开的美团、抖音页重新塞一遍页面脚本，并让它们重新扫一遍消息。
 * 否则后台睡一觉醒来，页面脚本可能已经死了，看起来像「插件挂了」。
 */
async function reinjectPlatformTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://life.douyin.com/*', 'https://g.dianping.com/*', 'https://ecom.meituan.com/*']
  });
  for (const tab of tabs) {
    if (!tab.id)
      continue;
    await injectAllFrames(tab.id);
    if (/life\.douyin\.com/i.test(tab.url || '')) {
      // 抖音列表有时不理插件世界里的点击，要在「网页自己的环境」再装一份点击脚本
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        files: ['douyin-main-click.js']
      }).catch(() => undefined);
    }
    chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => undefined);
  }
}

/**
 * 用户升级扩展时：把旧设置改成新结构。
 *
 * 以前美团选择器散落在最外层；现在按「美团 / 抖音」分开存。
 * 若发现还是测试用的假选择器、或会误伤的太宽选择器，强制改回代码里的默认值。
 */
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
  // 抖音：关键 CSS 选择器用最新默认值盖掉（页面改版后旧值会失效）；其它字段尽量保留
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
    // 最外层再抄一份美团字段，照顾还在读旧字段的代码
    ...profiles.meituan
  };
  await chrome.storage.local.set(migrated);
  return migrated;
}

/** 读用户配置；发现版本号偏旧就先跑迁移。 */
async function getSettings() {
  const saved = await chrome.storage.local.get();
  if (Number(saved.settingsVersion ?? 0) < GLOBAL_SETTINGS.settingsVersion)
    return migrateSettings({ ...DEFAULT_SETTINGS, ...saved });
  return { ...DEFAULT_SETTINGS, ...saved };
}

function setState(state, error = '') {
  // 写进 Chrome 本地存储，关掉弹窗再打开仍能看到「连没连上」
  connectionState = state;
  chrome.storage.local.set({ connectionState: state, connectionError: error });
}

// ---------------------------------------------------------------------------
// 三、连本机中台：收回复、同步白名单
// ---------------------------------------------------------------------------

async function connect() {
  // 可以反复调用；已经在连 / 已连上就别再 new 一个，否则会搞出两条线
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
    // 告诉中台：用户有没有勾「允许自动发送」
    send({ type: 'client_settings', payload: { autoSendEnabled: settings.autoSend === true } });
    // 重连后先清空中台侧旧会话登记，再把当前还认识的客户重新报一遍，防串客户
    send({ type: 'reset_sessions' });
    for (const { session } of sessionTargets.values())
      send({ type: 'hello', payload: session });
    // 断线期间攒下的诊断信息补发出去
    for (const payload of pendingDiagnostics.splice(0, pendingDiagnostics.length))
      send({ type: 'diagnostics', payload });
    void reinjectPlatformTabs();
  });

  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);

    // 中台写好了一条建议回复 → 送到对应网页去填框 / 发送
    if (message.type === 'draft') {
      const target = resolveDraftTarget(message.session);
      if (target) {
        chrome.tabs.sendMessage(target.tabId, {
          type: 'applyDraft',
          session: message.session,
          payload: message.payload
        }, { frameId: target.frameId }).catch(() => undefined);
      } else if (message.session?.platform === 'douyin') {
        // 对照表里暂时找不到人：抖音页全广播一遍，
        // 页面脚本自己再切到正确客户（总比草稿直接丢了强）
        void chrome.tabs.query({ url: ['https://life.douyin.com/*'] }).then((tabs) => {
          for (const tab of tabs) {
            if (!tab.id)
              continue;
            chrome.tabs.sendMessage(tab.id, {
              type: 'applyDraft',
              session: message.session,
              payload: message.payload
            }).catch(() => undefined);
          }
        });
      }
    }

    // 握手成功：配置页上的客户白名单同步进扩展本地
    if (message.type === 'connected') {
      const profiles = { ...(await chrome.storage.local.get('platformProfiles')).platformProfiles || {} };
      // 空数组也要写：表示「不限制客户」；不写的话会一直用旧白名单
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
    // 等 3 秒再连：中台正在重启时别疯狂撞门
    reconnectTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => setState('error', '无法连接本地 API，请确认 pnpm dev 已启动'));
}

function send(message) {
  forwardToServer(message);
}

// ---------------------------------------------------------------------------
// 四、页面脚本 / 弹窗发来的消息（按 type 分支）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // —— 页面说：我现在打开的是某某客户 ——
  if (message.type === 'session') {
    const key = `${message.payload.platform}:${message.payload.conversationId}`;
    const frameKey = `${sender.tab?.id ?? 'unknown'}:${sender.frameId ?? 0}`;
    const previousKey = frameSessions.get(frameKey);
    // 同一个聊天框从 A 切到 B：先跟中台说 A 不归我了，再登记 B
    if (previousKey && previousKey !== key) {
      const previous = sessionTargets.get(previousKey);
      if (previous) {
        send({ type: 'remove_session', payload: previous.session });
        unregisterSessionKeys(sessionLookupKeys(previous.session));
      }
    }
    frameSessions.set(frameKey, key);
    registerSessionTarget(message.payload, sender.tab?.id, sender.frameId ?? 0);
    // 页面读到了真实门店 id，写回本地，弹窗里别再显示 default-shop
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
    // 跟中台打招呼：这个客户归我管了，有回复请推给我
    send({ type: 'hello', payload: message.payload });
  }

  // —— 页面说：这个客户还有待发回复，别重新算 AI，把库里的草稿再推一遍 ——
  if (message.type === 'request_drafts') {
    registerSessionTarget(message.payload, sender.tab?.id, sender.frameId ?? 0);
    send({ type: 'request_drafts', payload: message.payload });
  }

  // —— 页面说：我离开可回复区域了（例如进了「历史咨询」），别再往这儿推草稿 ——
  if (message.type === 'clearFrameSession') {
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

  // —— 客户发来的话 / 商家已发出的话，原样转给中台入库 ——
  if (message.type === 'inbound')
    send({ type: 'inbound', requestId: message.requestId, payload: message.payload });
  if (message.type === 'outbound')
    send({ type: 'outbound', requestId: message.requestId, payload: message.payload });

  // —— 选择器好不好使、有没有未读等，转给中台给引导页看 ——
  if (message.type === 'diagnostics')
    forwardToServer({ type: 'diagnostics', payload: message.payload });

  // —— 这次有没有真的点到「发送」、还是只填了输入框 ——
  if (message.type === 'draft_send_result')
    send({ type: 'draft_send_result', payload: message.payload });

  // —— 弹窗改了开关：断开重连一次，并把新脚本塞进页面 ——
  if (message.type === 'settingsChanged') {
    socket?.close();
    void connect();
    void reinjectPlatformTabs();
  }

  // —— 弹窗问：现在连上了吗、管着几个客户 ——
  if (message.type === 'getStatus')
    sendResponse({ state: connectionState, sessionCount: sessionTargets.size, sessions: [...sessionTargets.values()].map((item) => item.session) });

  // —— 抖音：请在网页自己的环境里帮我点一下左侧客户 ——
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

  // —— 打开弹窗时立刻试连，别干等定时器 ——
  if (message.type === 'ensureConnection') {
    void connect();
    sendResponse({ ok: true });
  }

  // Chrome 规定：后面还要异步回 sendResponse 时，这里必须 return true
  return true;
});

// ---------------------------------------------------------------------------
// 五、安装 / 开机 / 定时器 / 打开网页时注入脚本
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get();
  // 只补缺的默认项，用户勾过的「自动发送」等不要冲掉
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
  // 大约每 30 秒醒一次：Chrome 把后台杀掉后，靠这个闹钟再连上中台
  await chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
  void connect();
  void reinjectPlatformTabs();
});

chrome.runtime.onStartup.addListener(() => {
  // 用户开机开浏览器后，后台是全新的，必须自己去连中台（不能等用户点开插件）
  chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
  void connect();
  void reinjectPlatformTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rpa-reconnect' && socket?.readyState !== WebSocket.OPEN)
    void connect();
});

/** 往某个标签页的所有小页面里注入 content 脚本（聊天常在 iframe 里）。 */
async function injectAllFrames(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['platform-profiles.js', 'content.js'] });
  } catch {
    // 登录页、浏览器内部页可能会拒绝注入，忽略即可
  }
}

/** 把标签页里有哪些小页面报给中台，方便排障（不读聊天内容）。 */
async function reportFrameMap(tabId) {
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
    // 标签页已经关了就算了
  }
}

chrome.webNavigation.onCompleted.addListener((details) => {
  // 只关心美团经营宝、抖音来客
  if (!/^https:\/\/g\.dianping\.com\//.test(details.url) && !/^https:\/\/life\.douyin\.com\//.test(details.url))
    return;
  // 聊天小页面是后加载的，每个小页面加载完都要单独塞脚本
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

// 每 20 秒跟中台打个招呼，证明扩展还活着
setInterval(() => send({ type: 'heartbeat' }), 20000);
// 用户点「重新加载扩展」时不一定走 onInstalled，这里也建一次闹钟并立刻连
chrome.alarms.create('rpa-reconnect', { periodInMinutes: 0.5 });
void connect();
