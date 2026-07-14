/**
 * @file extensions/customer-ai-rpa/content.js
 * @module RPA 与 Chrome 插件
 * @description DOM/Shadow DOM 消息采集、未读队列、会话切换、回填和发送。
 * @see 联动关注：平台 DOM 变化与串话防护。
 */
if (!globalThis.__customerAiRpaInjected) {
globalThis.__customerAiRpaInjected = true;
const seenMessages = new Set();
const submittedInboundIds = new Set();
/** 已提交过的「会话+方向+正文」指纹，防止 ID 抖动时未读角标把旧消息再提一次。 */
const submittedInboundContents = new Set();
/** 抖音同一会话最近一次入站正文，用于吞掉流式残文（「你」→「你好」）和虚拟列表回放。 */
const lastDouyinInboundByConversation = new Map();
const initializedConversations = new Set();
let observer;
let scanTimer;
let scanInterval;
let contextStopped = false;
let conversationTask = null;
let schedulerTimer;

function stopInvalidExtensionContext() {
  // 扩展重新加载后旧脚本上下文失效，必须停止观察器和定时器，避免持续刷异常。
  if (contextStopped)
    return;
  contextStopped = true;
  observer?.disconnect();
  clearTimeout(scanTimer);
  clearInterval(scanInterval);
  clearTimeout(schedulerTimer);
}

function isExtensionContextAlive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

async function safeRuntimeMessage(message) {
  // 所有跨扩展通信统一捕获 context invalidated，不能让异步异常打断经营宝页面。
  if (!isExtensionContextAlive()) {
    stopInvalidExtensionContext();
    return null;
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (/Extension context invalidated/i.test(String(error)))
      stopInvalidExtensionContext();
    return null;
  }
}

function getSearchRoots(targetDocument) {
  // 经营宝聊天节点位于封闭 Shadow DOM；Chrome 扩展 API 可读取 closed root，但仍遵守跨域边界。
  const roots = [targetDocument];
  const visited = new Set(roots);
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    for (const element of root.querySelectorAll('*')) {
      let shadowRoot = element.shadowRoot;
      if (!shadowRoot && chrome.dom?.openOrClosedShadowRoot) {
        try {
          shadowRoot = chrome.dom.openOrClosedShadowRoot(element);
        } catch {
          shadowRoot = null;
        }
      }
      if (shadowRoot && !visited.has(shadowRoot)) {
        visited.add(shadowRoot);
        roots.push(shadowRoot);
      }
    }
  }
  return roots;
}

function queryAllDeep(targetDocument, selector) {
  return getSearchRoots(targetDocument).flatMap((root) => [...root.querySelectorAll(selector)]);
}

function queryOneDeep(targetDocument, selector) {
  return queryAllDeep(targetDocument, selector)[0] || null;
}

function getAccessibleDocuments(rootDocument = document) {
  // 同源 iframe 递归扫描，跨域 iframe 交给其自身 Content Script，禁止绕过浏览器同源策略。
  const documents = [rootDocument];
  for (const frame of queryAllDeep(rootDocument, 'iframe')) {
    try {
      if (frame.contentDocument && frame.contentDocument.documentElement)
        documents.push(...getAccessibleDocuments(frame.contentDocument));
    } catch {
      // 跨域 iframe 由它自己的 Content Script 处理，父页面不能也不应绕过浏览器同源限制。
    }
  }
  return [...new Set(documents)];
}

function textOf(element, selector) {
  return (selector ? element.querySelector(selector)?.textContent : element.textContent)?.trim() ?? '';
}

function textOfDouyinBubble(element) {
  // 不要取气泡内第一个嵌套 div：流式渲染时子节点经常只是残字，会导致「你」「那」各自入队再狂回。
  const bubble = element?.closest?.('.chatd-bubble--other, .chatd-bubble-main, .chatd-message') || element;
  const main = bubble?.querySelector?.('.chatd-bubble-main') || bubble;
  return String(main?.innerText || main?.textContent || '').replace(/\s+/g, ' ').trim();
}

/** 去掉气泡前缀时间（如「11:36 新用户进线…」），避免切换会话时同一句系统提示因时间变化重复入队。 */
function stripDouyinTimePrefix(content) {
  return String(content || '')
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '')
    .replace(/^(刚刚|刚才|今天|昨天|星期[一二三四五六日天])\s+/, '')
    .trim();
}

/**
 * 抖音来客工作台系统提示（非客户原话）。
 * 切会话 / 未读角标回扫时常把这类气泡当成「新进线」，触发无意义 RAG/欢迎语。
 */
function isDouyinSystemNoticeContent(content) {
  const text = stripDouyinTimePrefix(content);
  if (!text)
    return true;
  return /新用户进线咨询/.test(text)
    || /用户超时未回复/.test(text)
    || /系统关闭会话|会话已结束|会话已关闭/.test(text)
    || /对方已离开会话|客服已接入|已转接/.test(text)
    || /^(系统消息|系统提示|平台通知)[:：]?/.test(text);
}

function createStableId(conversationId, direction, content, index, platform, element, occurrence = 1) {
  // 平台缺少 messageId 时才使用兜底 ID；数据库仍会做第二层去重。
  if (platform === 'douyin') {
    const explicit = element?.getAttribute?.('data-messageid') || element?.getAttribute?.('data-message-id');
    if (explicit)
      return explicit;
    // 禁止用 data-index / 「刚刚」等易变时间：虚拟列表重排会让旧气泡变成新 ID，从而重复入队、重复回复。
    // 同文案连发（如两次「你好」）用当前可见列表中的出现序号区分。
    return `${conversationId}:${direction}:${occurrence}:${content.slice(0, 120)}`;
  }
  return `${conversationId}:${direction}:${index}:${content}`;
}

/**
 * 抖音流式/回扫：上一句的残缺回放应跳过；上一句加长成完整句时允许提交（服务端会软去重短句）。
 * @returns {'skip'|'continue'}
 */
function classifyDouyinInboundEvolution(conversationId, content) {
  const previous = lastDouyinInboundByConversation.get(conversationId) || '';
  if (!previous || !content)
    return 'continue';
  if (previous === content)
    return 'skip';
  // 残字回放（完整句之后又扫到前缀）
  if (previous.startsWith(content) && content.length < previous.length)
    return 'skip';
  // 流式加长：允许用更长正文替换入队
  if (content.startsWith(previous) && content.length > previous.length)
    return 'continue';
  return 'continue';
}

function normalizeUnreadCount(raw) {
  const count = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(count) || count <= 0 || count > 99)
    return 0;
  return count;
}

function isDouyinPlaceholderName(name) {
  const normalized = normalizeConversationKey(name);
  if (!normalized)
    return true;
  return /^(抖音来客|抖音|来客|客服工作台|消息列表)$/.test(normalized)
    || /douyin/i.test(normalized);
}

function getDouyinSelectedListCustomerName(targetDocument) {
  const cards = queryAllDeep(targetDocument, '#list-container [class*="contactCard-"]');
  for (const card of cards) {
    let node = card;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const cls = String(node.className || '');
      if (/(^|\s|-)(active|selected|current|checked)(-|\s|$)/i.test(cls)) {
        const name = card.querySelector('[class*="uname-"]')?.textContent?.trim() || '';
        if (name)
          return name;
      }
    }
  }
  return '';
}

function readDouyinSession(targetDocument, settings, targetUrl) {
  const url = new URL(targetUrl);
  const accountId = url.searchParams.get('accountId') || '';
  // conGroupId 才是「单个顾客会话」；groupId/accountId 经常是账号级，当 conversationId 会导致串会话与 ID 抖动。
  const conGroupId = url.searchParams.get('conGroupId') || '';
  const lifeAccountId = url.searchParams.get('lifeAccountId') || '';
  const customerName = resolveDouyinCustomerName(targetDocument, settings);
  // 稳定会话键：有 conGroupId 时固定用它，避免昵称短暂读空时在「徐伟」↔「账号数字」之间来回跳。
  const conversationId = conGroupId || customerName || accountId || '';
  const customerId = conGroupId || accountId || customerName || '';
  return {
    platform: 'douyin',
    shopId: lifeAccountId || settings.shopId || 'default-shop',
    conversationId,
    customerId,
    customerName: customerName || undefined,
    pageUrl: targetUrl
  };
}

function readSession(targetDocument, settings, targetUrl) {
  if (settings.platform === 'douyin')
    return readDouyinSession(targetDocument, settings, targetUrl);
  return readMeituanSession(targetDocument, settings, targetUrl);
}

async function resolveSettings(targetUrl) {
  const stored = await chrome.storage.local.get();
  const merged = globalThis.__customerAiPlatformProfiles?.mergePlatformSettings(stored, null, targetUrl || location.href);
  return merged || stored;
}

function hasRealConversation(session) {
  if (session.platform === 'douyin') {
    if (!/life\.douyin\.com/i.test(session.pageUrl || ''))
      return false;
    if (isDouyinPlaceholderName(session.conversationId) && !/(?:groupId|accountId|conGroupId)=/i.test(session.pageUrl || ''))
      return false;
    return Boolean(session.customerName && !isDouyinPlaceholderName(session.customerName))
      || Boolean(session.conversationId && !isDouyinPlaceholderName(session.conversationId) && /(?:groupId|accountId|conGroupId)=/i.test(session.pageUrl || ''));
  }
  return session.shopId !== 'default-shop'
    && !['经营宝聊天页', '/dzim-workbench-pc/index.html'].includes(session.conversationId);
}

function readMeituanSession(targetDocument, settings, targetUrl) {
  // 会话必须从经营宝真实埋点提取 shopId/userId，页面标题不能作为生产会话 ID。
  const userCenter = queryOneDeep(targetDocument, settings.sessionRootSelector || '.user-center[lx-mv]');
  let tracking = {};
  try {
    tracking = JSON.parse(userCenter?.getAttribute(settings.trackingAttribute || 'lx-mv') || '{}');
  } catch {
    // 埋点属性格式变化时退回页面标题，但不阻断消息监听。
  }
  const lab = tracking.lab || {};
  const customerName = userCenter?.querySelector(settings.customerNameSelector || '.userinfo-name-show')?.textContent?.trim();
  const fallback = targetDocument.title || new URL(targetUrl).pathname;
  return {
    platform: settings.platform || 'meituan',
    shopId: lab.shopId || lab.account_id || settings.shopId || 'default-shop',
    conversationId: lab.userId || fallback,
    customerId: lab.userId || fallback,
    customerName: customerName || undefined,
    pageUrl: targetUrl
  };
}

function buildDomSnapshot() {
  // AI 只接收标签、稳定 class 和控件语义，不上传聊天正文、客户 ID、手机号或图片地址。
  const platform = globalThis.__customerAiPlatformProfiles?.detectPlatformFromUrl(location.href) || 'meituan';
  const nodes = [];
  const candidateSelector = platform === 'douyin'
    ? '.chatd-message,.chatd-bubble,[class*="inputWrapper-"] textarea,button[class*="sendBtn-"],[class*="contactCard-"],[class*="uname-"]'
    : '.message-cell-container,.message-wrapper,.text-message,[contenteditable],button,.dzim-chat-input-send,.user-center,.userinfo-name-show,[lx-mv]';
  for (const targetDocument of getAccessibleDocuments()) {
    for (const element of queryAllDeep(targetDocument, candidateSelector)) {
      nodes.push({
        ...selectorShape(element),
        parent: element.parentElement ? selectorShape(element.parentElement) : null,
        // 仅上报控件语义，不把元素文本或客户数据发送给模型。
        semantics: {
          incoming: Boolean(element.closest('.left-message') || element.querySelector('.left-message')),
          outgoing: Boolean(element.closest('.right-message') || element.querySelector('.right-message')),
          editable: element.matches('[contenteditable],textarea'),
          sendControl: element.matches('button') && /发送/.test(element.textContent || '')
        }
      });
      if (nodes.length >= 300)
        break;
    }
    if (nodes.length >= 300)
      break;
  }
  return { platform, nodes, counts: { documents: getAccessibleDocuments().length } };
}

function validateAiSelectors(selectors) {
  // AI 只能给候选；真实页面必须验证方向和唯一命中数量，验证失败不得覆盖旧配置。
  try {
    const documents = getAccessibleDocuments();
    const messageItems = documents.flatMap((doc) => queryAllDeep(doc, selectors.messageItemSelector));
    const outgoingMatches = messageItems.filter((item) => item.matches('.right-message') || item.querySelector('.right-message'));
    const textHits = messageItems.filter((item) => item.matches(selectors.messageTextSelector) || item.querySelector(selectors.messageTextSelector));
    const inputHits = documents.flatMap((doc) => queryAllDeep(doc, selectors.replyInputSelector));
    const sendHits = documents.flatMap((doc) => queryAllDeep(doc, selectors.sendButtonSelector));
    const sessionHits = documents.flatMap((doc) => queryAllDeep(doc, selectors.sessionRootSelector));
    const valid = messageItems.length > 0 && outgoingMatches.length === 0
      && textHits.length === messageItems.length && inputHits.length === 1
      && sendHits.length === 1 && sessionHits.length === 1;
    return { valid, counts: { messageItems: messageItems.length, outgoingMatches: outgoingMatches.length, textHits: textHits.length, inputHits: inputHits.length, sendHits: sendHits.length, sessionHits: sessionHits.length } };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function selectorShape(element) {
  const classes = [...element.classList].filter((name) => /^[a-zA-Z_][\w-]{1,80}$/.test(name)).slice(0, 4);
  const attributes = {};
  for (const name of ['role', 'contenteditable', 'data-testid', 'lx-mv']) {
    const value = element.getAttribute(name);
    if (value)
      attributes[name] = name === 'lx-mv' ? '[redacted]' : value.slice(0, 120);
  }
  return { tag: element.tagName.toLowerCase(), idPresent: Boolean(element.id), classes, attributes };
}

function collectDiagnostics(settings, targetDocument) {
  // 诊断数据用于选择器失效排查，属性值按白名单采集并对 lx-mv 做脱敏。
  const classCounts = new Map();
  const conversationItems = conversationItemsOf(targetDocument, settings);
  const unreadConversationItems = conversationItems.filter((item) => unreadCountOf(item, settings) > 0);
  for (const element of queryAllDeep(targetDocument, 'div,li,article,section')) {
    const text = element.textContent?.trim() ?? '';
    const rect = element.getBoundingClientRect();
    if (!text || text.length > 120 || rect.width < 20 || rect.height < 12 || rect.height > 180)
      continue;
    for (const className of element.classList) {
      if (/^[a-zA-Z_][\w-]{2,80}$/.test(className))
        classCounts.set(className, (classCounts.get(className) ?? 0) + 1);
    }
  }
  return {
    pageUrl: targetDocument.location?.href || location.href,
    frameTitle: targetDocument.title,
    configuredCounts: {
      messageItems: settings.platform === 'douyin'
        ? queryDouyinMessageItems(targetDocument, settings).length
        : (settings.messageItemSelector ? queryAllDeep(targetDocument, settings.messageItemSelector).length : 0),
      messageTexts: settings.messageTextSelector ? queryAllDeep(targetDocument, settings.messageTextSelector).length : 0,
      replyInputs: settings.platform === 'douyin'
        ? (queryDouyinReplyInput(targetDocument, settings) ? 1 : 0)
        : (settings.replyInputSelector ? queryAllDeep(targetDocument, settings.replyInputSelector).length : 0),
      sendButtons: settings.sendButtonSelector ? queryAllDeep(targetDocument, settings.sendButtonSelector).length : 0
    },
    conversationCounts: {
      items: conversationItems.length,
      unread: unreadConversationItems.length,
      allowedUnread: unreadConversationItems.filter((item) => isAllowedConversation(settings, null, item)).length,
      needSwitch: Boolean(shouldSwitchToUnread(targetDocument, settings)),
      replyReady: isReplyReady(targetDocument, settings),
      chatReady: settings.platform === 'douyin' ? isDouyinChatReady(targetDocument, settings) : undefined,
      chatLoading: settings.platform === 'douyin' ? isDouyinChatLoading(targetDocument) : undefined,
      chatClosed: settings.platform === 'douyin' ? isDouyinChatClosed(targetDocument) : false,
      centerCustomer: settings.platform === 'douyin'
        ? getDouyinCenterCustomerName(targetDocument, settings, targetDocument.location?.href || location.href)
        : undefined,
      centerIsSystemSession: settings.platform === 'douyin'
        ? isDouyinSystemSessionName(getDouyinCenterCustomerName(targetDocument, settings, targetDocument.location?.href || location.href))
        : undefined,
      cardUnreadCount: settings.platform === 'douyin'
        ? getDouyinCardUnreadCountForSession(targetDocument, settings, readDouyinSession(targetDocument, settings, targetDocument.location?.href || location.href))
        : undefined,
      listTab: settings.platform === 'douyin' ? getDouyinListTabMode(targetDocument) : undefined
    },
    settingsState: {
      // 只暴露布尔状态，避免把白名单客户 ID 写进诊断日志。
      enabled: settings.enabled === true,
      autoSwitchConversations: settings.autoSwitchConversations === true,
      autoSend: settings.autoSend === true,
      allowedCustomerIdsPresent: allowedCustomersOf(settings).length > 0
    },
    editables: queryAllDeep(targetDocument, '[contenteditable="true"],[contenteditable="plaintext-only"],textarea').slice(0, 10).map(selectorShape),
    sendControls: queryAllDeep(targetDocument, 'button,[role="button"]')
      .filter((element) => /发送/.test(element.textContent ?? '')).slice(0, 10).map(selectorShape),
    repeatedClasses: [...classCounts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30)
  };
}

function normalizeConversationKey(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .trim();
}

function conversationIdsMatch(expected, actual, settings, session) {
  if (!expected || !actual)
    return expected === actual;
  if (expected === actual)
    return true;
  if (settings?.platform !== 'douyin')
    return false;
  const left = normalizeConversationKey(expected);
  const right = normalizeConversationKey(actual);
  if (!left || !right)
    return false;
  if (left.includes(right) || right.includes(left))
    return true;
  const sessionName = normalizeConversationKey(session?.customerName);
  return Boolean(sessionName) && (left.includes(sessionName) || sessionName.includes(left) || right.includes(sessionName) || sessionName.includes(right));
}

function sessionsMatch(expected, current, settings) {
  if (!expected || !current)
    return false;
  if (expected.shopId && current.shopId && expected.shopId !== current.shopId)
    return false;
  if (settings?.platform === 'meituan') {
    return Boolean(
      (expected.conversationId && expected.conversationId === current.conversationId)
      || (expected.customerId && expected.customerId === current.customerId)
    );
  }
  return conversationIdsMatch(expected.conversationId, current.conversationId, settings, current)
    || conversationIdsMatch(expected.customerName, current.customerName, settings, current)
    || conversationIdsMatch(expected.customerName, current.conversationId, settings, current);
}

function conversationMatchesTask(session, task, settings) {
  if (!task)
    return false;
  if (settings?.platform === 'meituan') {
    // 侧栏常用 userId，聊天区埋点偶发延迟；同时兼容 conversationId / customerId / 昵称，避免误判已离开。
    const currentId = session.conversationId || session.customerId;
    if (task.expectedConversationId && currentId && task.expectedConversationId === currentId)
      return true;
    if (task.expectedConversationId && session.customerId && task.expectedConversationId === session.customerId)
      return true;
    if (task.expectedCustomerName && session.customerName
      && conversationIdsMatch(task.expectedCustomerName, session.customerName, settings, session))
      return true;
    return false;
  }
  if (conversationIdsMatch(task.expectedConversationId, session.conversationId, settings, session))
    return true;
  if (task.expectedCustomerName)
    return conversationIdsMatch(task.expectedCustomerName, session.customerName || session.conversationId, settings, session);
  return false;
}

function unreadSelectorsOf(settings) {
  const raw = settings.conversationUnreadSelector || '.mtd-badge-text.mtd-badge-position';
  return raw.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^#list-container\s+/, ''));
}

function isDouyinSystemSessionName(name) {
  const normalized = normalizeConversationKey(name);
  if (!normalized)
    return false;
  return /预警通知|系统消息|系统通知|平台通知|官方通知|消息中心|通知中心/.test(normalized)
    || /通知$/.test(normalized);
}

function douyinFallbackUnreadCount(item) {
  // 只在角标节点上读数字，避免把 accountId 等大数字误判为未读数。
  const selectors = '.life-im-pc-badge-text, [class*="badge-number-"], .life-im-pc-badge-sup-show, sup';
  for (const node of item.querySelectorAll(selectors)) {
    const count = normalizeUnreadCount(node.textContent);
    if (!count)
      continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.width > 36 || rect.height > 36)
      continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      continue;
    return count;
  }
  return 0;
}

function unreadCountOf(item, settings) {
  // 平台角标可能只显示红点，也可能显示数字；红点按一条未读处理，避免整条会话永远遗漏。
  for (const selector of unreadSelectorsOf(settings)) {
    const badge = item.querySelector(selector);
    if (!badge || badge.hidden)
      continue;
    const style = getComputedStyle(badge);
    const rect = badge.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0)
      continue;
    const explicitCount = normalizeUnreadCount(item.getAttribute('data-unread-count'));
    if (explicitCount > 0)
      return explicitCount;
    const textCount = normalizeUnreadCount(badge.textContent);
    return textCount > 0 ? textCount : 1;
  }
  if (settings?.platform === 'douyin') {
    const badges = item.querySelectorAll('.life-im-pc-badge, [class*="badge-number-"]');
    for (const badge of badges) {
      const textCount = normalizeUnreadCount(badge.textContent);
      if (textCount > 0)
        return textCount;
      const rect = badge.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && badge.querySelector('.life-im-pc-badge-text'))
        return 1;
    }
    const badgeText = item.querySelector('.life-im-pc-badge-text');
    const textCount = normalizeUnreadCount(badgeText?.textContent);
    if (textCount > 0)
      return textCount;
    if (/用户催促/.test(item.textContent || ''))
      return 1;
    const fallback = douyinFallbackUnreadCount(item);
    if (fallback > 0)
      return fallback;
  }
  return 0;
}

function conversationIdOf(item, settings) {
  if (settings?.platform === 'douyin') {
    return item.querySelector('[class*="uname-"]')?.textContent?.trim()
      || item.getAttribute('data-conversation-id')
      || item.getAttribute('data-customer-id')
      || item.getAttribute('data-user-id')
      || '';
  }
  return item.getAttribute('data-conversation-id')
    || item.getAttribute('data-customer-id')
    || item.getAttribute('data-user-id')
    || item.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')
    || '';
}

function getDouyinCardUnreadCountForSession(targetDocument, settings, session) {
  const card = conversationItemsOf(targetDocument, settings).find((item) => {
    const name = conversationIdOf(item, settings);
    return conversationIdsMatch(name, session.customerName || session.conversationId, settings, session);
  });
  return card ? unreadCountOf(card, settings) : 0;
}

function getDouyinCenterCustomerName(targetDocument, settings, targetUrl) {
  return getDouyinDomCustomerName(targetDocument, settings)
    || readDouyinSession(targetDocument, settings, targetUrl).customerName
    || '';
}

function conversationItemsOf(targetDocument, settings) {
  if (settings.platform === 'douyin' && isDouyinHistoryTabActive(targetDocument))
    return [];
  const selector = settings.platform === 'douyin'
    ? '#list-container > [class*="contactCard-"], #list-container [class*="contactCard-"]'
    : (settings.conversationItemSelector || '.chat-list-item-wrapper,.chat-list-item,.virtual-list-item');
  return queryAllDeep(targetDocument, selector)
    .filter((item, index, all) => item.textContent?.trim() && all.findIndex((candidate) => candidate === item || candidate.contains(item)) === index);
}

function clickableConversationTarget(item, settings) {
  if (settings?.platform === 'douyin')
    return item.closest('[class*="contactCard-"]') || item;
  // 优先点击真正承载会话的节点；如果命中的是外层虚拟列表，则退回内部 item，保持与人工点击一致。
  return item.matches('.chat-list-item,.chat-list-item-wrapper')
    ? item
    : item.querySelector('.chat-list-item,.chat-list-item-wrapper') || item;
}

function allowedCustomersOf(settings) {
  return String(settings.allowedCustomerIds || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowedConversation(settings, session, conversationItem) {
  // 白名单为空时放行全部客户；抖音/美团同一规则，由服务端配置页统一下发。
  const allowedCustomers = allowedCustomersOf(settings);
  if (!allowedCustomers.length)
    return true;
  const candidates = [
    session?.conversationId,
    session?.customerId,
    session?.customerName,
    conversationItem ? conversationIdOf(conversationItem, settings) : '',
    conversationItem?.textContent?.trim()
  ].filter(Boolean).map(String);
  // 真实平台灰度只处理指定测试用户；左侧列表无法稳定读 userId 时允许文本包含测试 ID。
  return allowedCustomers.some((allowed) => candidates.some((candidate) => candidate === allowed || candidate.includes(allowed)));
}

function setProcessingStatus(text) {
  // Mock 页面提供状态占位；真实平台没有该节点时静默跳过，不向经营宝 DOM 注入额外 UI。
  for (const targetDocument of getAccessibleDocuments()) {
    const status = queryOneDeep(targetDocument, '[data-rpa-processing-status]');
    if (status)
      status.textContent = text;
  }
}

function clearConversationTask(reason) {
  // 当前页面已经切到非目标会话时必须释放串行锁，否则左侧白名单未读会一直等不到自动切换。
  if (!conversationTask)
    return;
  clearTimeout(schedulerTimer);
  conversationTask = null;
  if (reason)
    setProcessingStatus(reason);
}

function dispatchEditableInput(input, content) {
  if (input.tagName === 'TEXTAREA') {
    const targetDocument = input.ownerDocument;
    input.focus();
    // React 受控 textarea 直接改 .value 不会更新内部状态，发送按钮可能一直 disabled。
    const nativeSetter = Object.getOwnPropertyDescriptor(targetDocument.defaultView?.HTMLTextAreaElement?.prototype || HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter)
      nativeSetter.call(input, content);
    else
      input.value = content;
    for (const event of [
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }),
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }),
      new Event('change', { bubbles: true })
    ])
      input.dispatchEvent(event);
    return;
  }
  // 经营宝的输入框是 contenteditable 的 pre，内部框架可能依赖 beforeinput/input/selectionchange。
  // 不能只改 textContent，否则页面视觉上或许变了，但发送按钮状态和框架模型未必同步。
  const targetDocument = input.ownerDocument;
  input.focus();
  const selection = targetDocument.defaultView?.getSelection();
  const range = targetDocument.createRange();
  input.replaceChildren();
  input.appendChild(targetDocument.createTextNode(content));
  range.selectNodeContents(input);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
  for (const event of [
    new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }),
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }),
    new Event('change', { bubbles: true }),
    new KeyboardEvent('keyup', { bubbles: true, key: 'Process', code: 'Process' })
  ])
    input.dispatchEvent(event);
  targetDocument.dispatchEvent(new Event('selectionchange', { bubbles: true }));
}

function isDouyinSendButtonReady(targetDocument, settings) {
  const button = resolveSendButton(targetDocument, settings.sendButtonSelector, settings);
  return Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
}

async function waitForDouyinSendReady(targetDocument, settings, input, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDouyinSendButtonReady(targetDocument, settings))
      return true;
    input.focus?.();
    await sleep(180);
  }
  return isDouyinSendButtonReady(targetDocument, settings);
}

function releaseConversationTaskAfterDraft(expectedSession, settings, delayMs = 800) {
  if (!conversationTask || !conversationMatchesTask(expectedSession, conversationTask, settings))
    return;
  clearTimeout(schedulerTimer);
  conversationTask = null;
  setTimeout(scanMessages, delayMs);
}

async function attemptAutoSend(input, targetDocument, settings) {
  dismissSmartReplyOverlay(targetDocument);
  let clicked = false;
  let method = '';
  for (let attempt = 0; attempt < 5 && !clicked; attempt += 1) {
    if (settings.platform === 'douyin')
      await waitForDouyinSendReady(targetDocument, settings, input, 1200);
    clicked = clickSendControl(targetDocument, settings.sendButtonSelector, settings);
    method = clicked ? 'send-button' : method;
    if (!clicked) {
      trySubmitByEnter(input);
      clicked = clickSendControl(targetDocument, settings.sendButtonSelector, settings);
      method = clicked ? 'enter+send-button' : 'enter-only';
    }
    if (!clicked)
      await sleep(350);
  }
  if (clicked) {
    setTimeout(() => {
      const stillHasText = String(input.value ?? input.textContent ?? '').trim();
      // 仅当输入框仍有内容时才补点一次，避免已成功发送后二次点击造成重复消息。
      if (!stillHasText)
        return;
      dismissSmartReplyOverlay(targetDocument);
      clickSendControl(targetDocument, settings.sendButtonSelector, settings);
    }, 500);
  }
  return { clicked, method: method || (clicked ? 'send-button' : 'none') };
}

function dismissSmartReplyOverlay(targetDocument) {
  // 经营宝输入后会弹出“智能推荐回复”，可能挡住发送按钮或抢走焦点。
  const labels = Array.from(targetDocument.querySelectorAll('*')).filter((node) => {
    const text = node.textContent?.trim();
    return text === '智能推荐回复' || text === '关闭';
  });
  for (const label of labels) {
    const closeButton = label.closest('[class*="recommend"],[class*="suggest"],[class*="popup"],[class*="popover"]')
      ?.querySelector('button,[role="button"],.mtd-icon-close,[class*="close"]');
    if (closeButton) {
      closeButton.click();
      return true;
    }
  }
  targetDocument.activeElement?.dispatchEvent?.(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true
  }));
  return false;
}

function resolveSendButton(targetDocument, selector, settings) {
  const preferred = settings?.platform === 'douyin'
    ? [
        selector,
        '[class*="inputWrapper-"] button[class*="sendBtn-"]',
        '[class*="send-"] button.life-im-pc-btn-type-primary'
      ]
    : [
        selector,
        '.dzim-chat-input-send > button.send-button',
        '.dzim-chat-input-send > button.dzim-button-primary',
        '.dzim-chat-input-send button'
      ].filter(Boolean);
  for (const item of preferred) {
    const button = queryOneDeep(targetDocument, item);
    if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true')
      return button;
  }
  const scoped = settings?.platform === 'douyin'
    ? queryAllDeep(targetDocument, '[class*="inputWrapper-"] button, [class*="send-"] button')
    : queryAllDeep(targetDocument, '.dzim-chat-input-send button, .dzim-chat-input-send [role="button"]');
  return scoped.find((button) => button.tagName === 'BUTTON' && (button.textContent || '').trim() === '发送') || null;
}

function clickSendControl(targetDocument, selector, settings) {
  dismissSmartReplyOverlay(targetDocument);
  const button = resolveSendButton(targetDocument, selector, settings);
  if (!button)
    return false;
  if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('disabled') != null)
    return false;
  const view = targetDocument.defaultView;
  const rect = button.getBoundingClientRect();
  const clientX = rect.left + Math.max(rect.width / 2, 1);
  const clientY = rect.top + Math.max(rect.height / 2, 1);
  button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  button.focus?.();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventCtor = type.startsWith('pointer') && view?.PointerEvent ? view.PointerEvent : MouseEvent;
    button.dispatchEvent(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      view,
      buttons: 1,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    }));
  }
  if (typeof button.click === 'function')
    button.click();
  return true;
}

function trySubmitByEnter(input) {
  // 部分经营宝版本更认输入框回车，而不是发送按钮的合成点击。
  const view = input.ownerDocument.defaultView;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      view
    }));
  }
}

function clickConversationItem(item, settings) {
  const target = clickableConversationTarget(item, settings);
  const view = target.ownerDocument.defaultView;
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  const rect = target.getBoundingClientRect();
  const clientX = rect.left + Math.max(rect.width / 2, 1);
  const clientY = rect.top + Math.max(rect.height / 2, 1);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventCtor = type.startsWith('pointer') && view?.PointerEvent ? view.PointerEvent : MouseEvent;
    target.dispatchEvent(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      view,
      buttons: 1,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    }));
  }
  if (typeof target.click === 'function')
    target.click();
}

function findDouyinTabByLabel(targetDocument, label) {
  return queryAllDeep(targetDocument, '[role="tab"], button, div, span, a')
    .find((element) => element.textContent?.trim() === label
      && element.getBoundingClientRect().width > 0
      && element.getBoundingClientRect().height > 0);
}

function isDouyinTabSelected(element) {
  let node = element;
  for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
    if (node.getAttribute('aria-selected') === 'true')
      return true;
    const cls = String(node.className || '');
    if (/(^|\s|-)(active|selected|current|checked)(-|\s|$)/i.test(cls))
      return true;
  }
  return false;
}

function getDouyinListTabMode(targetDocument) {
  const historyTab = findDouyinTabByLabel(targetDocument, '历史咨询');
  const currentTab = findDouyinTabByLabel(targetDocument, '当前咨询');
  if (historyTab && isDouyinTabSelected(historyTab))
    return 'history';
  if (currentTab && isDouyinTabSelected(currentTab))
    return 'current';
  // 无法明确判断时默认当前咨询，避免误把 RPA 整页暂停。
  return 'current';
}

function isDouyinHistoryTabActive(targetDocument) {
  return getDouyinListTabMode(targetDocument) === 'history';
}

function isDouyinRpaAllowed(targetDocument, settings) {
  return settings?.platform !== 'douyin' || !isDouyinHistoryTabActive(targetDocument);
}

function isDouyinChatClosed(targetDocument) {
  const bodyText = targetDocument.body?.innerText || '';
  return /不可回复|会话已关闭|已关闭超过/i.test(bodyText)
    || Boolean(queryOneDeep(targetDocument, '[class*="disabledTextarea-"], textarea[class*="disabled"]'));
}

function isDouyinChatLoading(targetDocument) {
  // 只认聊天区内可见的 loading；侧栏隐藏节点会导致永远 chatReady=false。
  const loaders = queryAllDeep(targetDocument, '.life-im-pc-loading, .life-im-pc-loading-block, [class*="loading-block"]');
  const visibleLoader = loaders.find((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0)
      return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  });
  return Boolean(visibleLoader) && !queryDouyinReplyInput(targetDocument, { platform: 'douyin' });
}

function getDouyinDomCustomerName(targetDocument, settings) {
  // 只读页面真实顶部/选中态，禁止用 conversationTask 猜测，否则会误判“已在目标会话”。
  const selectors = [
    '[class*="topbar-"] [class*="uname-"]',
    '[class*="chatRoom-"] [class*="uname-"]',
    settings?.customerNameSelector
  ].filter(Boolean);
  for (const selector of selectors) {
    const name = queryOneDeep(targetDocument, selector)?.textContent?.trim();
    if (name && !isDouyinPlaceholderName(name) && !isDouyinSystemSessionName(name))
      return name;
  }
  const fromList = getDouyinSelectedListCustomerName(targetDocument);
  if (fromList && !isDouyinPlaceholderName(fromList) && !isDouyinSystemSessionName(fromList))
    return fromList;
  return '';
}

function resolveDouyinCustomerName(targetDocument, settings) {
  return getDouyinDomCustomerName(targetDocument, settings)
    || (conversationTask?.expectedCustomerName && !isDouyinPlaceholderName(conversationTask.expectedCustomerName)
      ? conversationTask.expectedCustomerName
      : '');
}

function queryDouyinReplyInput(targetDocument, settings) {
  const selectors = [
    settings?.replyInputSelector,
    '[class*="inputWrapper-"] textarea:not([class*="disabledTextarea"]):not([disabled])',
    '[class*="inputWrapper-"] textarea',
    'textarea[class*="textarea-"]'
  ].filter(Boolean);
  for (const selector of selectors) {
    const input = queryOneDeep(targetDocument, selector);
    if (!input || input.disabled)
      continue;
    if (String(input.className || '').includes('disabledTextarea'))
      continue;
    return input;
  }
  return null;
}

function queryDouyinMessageItems(targetDocument, settings) {
  const selectors = [
    settings?.messageItemSelector,
    '.chatd-message--left .chatd-bubble--other',
    '.chatd-message.chatd-message--left',
    '.chatd-bubble--other'
  ].filter(Boolean);
  for (const selector of selectors) {
    const items = queryAllDeep(targetDocument, selector)
      .filter((item) => !item.closest('.chatd-systemMessage') && !item.closest('.dynamic-card-'));
    if (items.length)
      return items;
  }
  return [];
}

function isDouyinChatReady(targetDocument, settings) {
  if (isDouyinChatClosed(targetDocument))
    return false;
  if (isDouyinChatLoading(targetDocument))
    return false;
  const emptyPlaceholder = queryOneDeep(targetDocument, '[class*="chatRoom-"][role="button"]');
  const hasInput = Boolean(queryDouyinReplyInput(targetDocument, settings));
  const hasMessages = queryDouyinMessageItems(targetDocument, settings).length > 0;
  if (emptyPlaceholder && !hasInput && !hasMessages)
    return false;
  return hasInput || hasMessages;
}

function isReplyReady(targetDocument, settings) {
  if (settings?.platform === 'douyin') {
    if (isDouyinChatClosed(targetDocument))
      return false;
    return Boolean(queryDouyinReplyInput(targetDocument, settings));
  }
  const input = settings.replyInputSelector ? queryOneDeep(targetDocument, settings.replyInputSelector) : null;
  if (!input)
    return false;
  if (input.disabled || input.getAttribute('aria-disabled') === 'true')
    return false;
  return true;
}

function shouldDeferSwitch(targetDocument, settings) {
  if (!isReplyReady(targetDocument, settings))
    return false;
  const input = queryOneDeep(targetDocument, settings.replyInputSelector);
  return Boolean(input?.textContent?.trim() || input?.value?.trim());
}

function findConversationItemByHint(targetDocument, settings, hint) {
  if (!hint)
    return null;
  const normalizedHint = normalizeConversationKey(hint);
  return conversationItemsOf(targetDocument, settings).find((item) => {
    const name = normalizeConversationKey(conversationIdOf(item, settings));
    return Boolean(name) && (name.includes(normalizedHint) || normalizedHint.includes(name));
  }) || null;
}

function shouldSwitchToUnread(targetDocument, settings) {
  const unreadItem = findUnreadConversationItem(targetDocument, settings);
  const targetUrl = targetDocument.location?.href || location.href;
  if (settings.platform === 'douyin') {
    const centerName = getDouyinDomCustomerName(targetDocument, settings);
    // 聊天区假切换/loading：即使顶部暂时无昵称，也要重新点左侧客户卡片。
    if (!isDouyinChatReady(targetDocument, settings)) {
      if (unreadItem)
        return unreadItem;
      const selected = getDouyinSelectedListCustomerName(targetDocument);
      if (selected && !isDouyinSystemSessionName(selected))
        return findConversationItemByHint(targetDocument, settings, selected);
      if (conversationTask?.expectedCustomerName)
        return findConversationItemByHint(targetDocument, settings, conversationTask.expectedCustomerName);
    }
    if (!unreadItem)
      return null;
    if (isDouyinChatClosed(targetDocument))
      return unreadItem;
    if (isDouyinSystemSessionName(centerName))
      return unreadItem;
    const unreadName = conversationIdOf(unreadItem, settings);
    if (!centerName)
      return unreadItem;
    if (!conversationIdsMatch(unreadName, centerName, settings, { customerName: centerName }))
      return unreadItem;
    return null;
  }
  if (!unreadItem)
    return null;
  const session = readSession(targetDocument, settings, targetUrl);
  if (!hasRealConversation(session))
    return unreadItem;
  const unreadId = conversationIdOf(unreadItem, settings);
  const currentId = session.conversationId || session.customerId;
  if (unreadId && currentId && unreadId !== currentId)
    return unreadItem;
  return null;
}

async function clickDouyinConversationItem(item, nameHint) {
  const card = item.closest('[class*="contactCard-"]') || item;
  const hint = nameHint || conversationIdOf(card, { platform: 'douyin' });
  clickConversationItem(card, { platform: 'douyin' });
  await safeRuntimeMessage({ type: 'douyinMainClick', nameHint: hint });
}

function beginConversationSwitch(settings, item, hint, options = {}) {
  const expectedConversationId = settings.platform === 'meituan'
    ? (conversationIdOf(item, settings) || hint || '')
    : (conversationIdOf(item, settings) || hint || '');
  const meituanName = settings.platform === 'meituan'
    ? (item.querySelector('.userinfo-name-show, [class*="name"]')?.textContent?.trim() || '')
    : '';
  conversationTask = {
    expectedConversationId,
    expectedCustomerName: settings.platform === 'douyin'
      ? (conversationIdOf(item, settings) || hint || '')
      : (meituanName || undefined),
    unreadCount: unreadCountOf(item, settings) || 1,
    phase: options.waitDraft ? 'waiting-draft' : 'switching',
    startedAt: Date.now()
  };
  clearTimeout(schedulerTimer);
  schedulerTimer = setTimeout(() => {
    if (conversationTask?.startedAt && Date.now() - conversationTask.startedAt >= 120000)
      conversationTask = null;
  }, 121000);
}

function scheduleMeituanUnreadConversation(settings, targetDocument) {
  const input = settings.replyInputSelector ? queryOneDeep(targetDocument, settings.replyInputSelector) : null;
  if (input?.textContent?.trim() || input?.value?.trim())
    return false;
  const unreadItem = findUnreadConversationItem(targetDocument, settings);
  if (!unreadItem)
    return false;
  // 切过去即进入串行等待，避免「仅 switching」窗口被其它未读打断。
  switchToConversation(settings, targetDocument, conversationIdOf(unreadItem, settings), { waitDraft: true });
  return true;
}

function scheduleDouyinUnreadConversation(settings, targetDocument) {
  if (isDouyinHistoryTabActive(targetDocument))
    return false;
  const switchItem = shouldSwitchToUnread(targetDocument, settings);
  if (!switchItem)
    return false;
  if (shouldDeferSwitch(targetDocument, settings))
    return false;
  switchToConversation(settings, targetDocument, conversationIdOf(switchItem, settings), { waitDraft: true });
  return true;
}

function switchToConversation(settings, targetDocument, hint, options = {}) {
  const item = findConversationItemByHint(targetDocument, settings, hint)
    || findUnreadConversationItem(targetDocument, settings);
  if (!item)
    return false;
  setProcessingStatus(`正在切换会话：${conversationIdOf(item, settings) || hint || ''}`);
  beginConversationSwitch(settings, item, hint, options);
  if (settings.platform === 'douyin')
    void clickDouyinConversationItem(item, hint || conversationIdOf(item, settings));
  else
    clickConversationItem(item, settings);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSessionDocument(settings, expectedSession) {
  return getAccessibleDocuments().find((candidate) => {
    const current = readSession(candidate, settings, candidate.location?.href || location.href);
    return sessionsMatch(expectedSession, current, settings);
  }) || null;
}

function findUnreadConversationItem(targetDocument, settings) {
  const unreadItems = conversationItemsOf(targetDocument, settings)
    .filter((item) => unreadCountOf(item, settings) > 0 && isAllowedConversation(settings, null, item));
  if (!unreadItems.length)
    return null;
  if (settings.platform === 'douyin') {
    // 客户未读优先于「预警通知」等系统会话，避免停在系统页不切换。
    return unreadItems.find((item) => !isDouyinSystemSessionName(conversationIdOf(item, settings))) || null;
  }
  return unreadItems[0];
}

function scheduleUnreadConversation(settings, targetDocument = document) {
  // 调度器严格串行：当前草稿尚未回填/发送完成时，禁止因其他未读抢切，否则 AI 慢时会丢当前会话。
  if (!settings?.autoSwitchConversations)
    return;
  // Agnes/自定义 LLM 偶发 30s+；等草稿窗口要覆盖完整生成+推送，避免未完成就跳走。
  const waitDraftTimeoutMs = 120000;
  // 草稿正在强制切回话/回填时，其它未读一律排队。
  if (conversationTask?.phase === 'applying-draft') {
    setProcessingStatus(`草稿投递中：${conversationTask.expectedCustomerName || conversationTask.expectedConversationId || ''}`);
    return;
  }
  // 切会话后短暂读不到正确埋点属正常，绝不能因「ID 暂未对齐」就放锁去抢下一个未读。
  if (conversationTask?.phase === 'waiting-draft') {
    const waitedMs = Date.now() - (conversationTask.startedAt || 0);
    if (waitedMs < waitDraftTimeoutMs) {
      setProcessingStatus(`等待 AI 回复：${conversationTask.expectedCustomerName || conversationTask.expectedConversationId || ''}`);
      return;
    }
    clearConversationTask('等待草稿超时，继续处理其他未读');
  }
  if (conversationTask?.phase === 'switching') {
    const waitedMs = Date.now() - (conversationTask.startedAt || 0);
    const targetUrl = targetDocument.location?.href || location.href;
    const session = readSession(targetDocument, settings, targetUrl);
    const landed = conversationMatchesTask(session, conversationTask, settings);
    if (settings.platform === 'douyin') {
      const chatReady = isDouyinChatReady(targetDocument, settings);
      if (waitedMs > 4000 && !chatReady)
        clearConversationTask('切换超时，重新点击会话');
    }
    if (conversationTask?.phase === 'switching' && waitedMs > 8000 && !landed)
      clearConversationTask('切换未完成，重新尝试');
    else if (conversationTask?.phase === 'switching' && landed) {
      // 已点进目标会话：升级为等草稿，其它未读继续排队。
      conversationTask.phase = 'waiting-draft';
      conversationTask.startedAt = Date.now();
      setProcessingStatus(`等待 AI 回复：${conversationTask.expectedCustomerName || conversationTask.expectedConversationId || ''}`);
      return;
    }
    else if (conversationTask?.phase === 'switching') {
      setProcessingStatus(`正在切换会话：${conversationTask.expectedCustomerName || conversationTask.expectedConversationId || ''}`);
      return;
    }
  }
  if (conversationTask)
    return;
  for (const doc of targetDocument ? [targetDocument] : getAccessibleDocuments()) {
    const switched = settings.platform === 'douyin'
      ? scheduleDouyinUnreadConversation(settings, doc)
      : scheduleMeituanUnreadConversation(settings, doc);
    if (switched)
      return;
  }
}

async function scanMessages() {
  if (!isExtensionContextAlive()) {
    stopInvalidExtensionContext();
    return;
  }
  for (const targetDocument of getAccessibleDocuments()) {
    const targetUrl = targetDocument.location?.href || location.href;
    if (!globalThis.__customerAiPlatformProfiles?.detectPlatformFromUrl(targetUrl))
      continue;
    let settings;
    try {
      settings = await resolveSettings(targetUrl);
    } catch {
      stopInvalidExtensionContext();
      return;
    }
    void safeRuntimeMessage({
      type: 'diagnostics',
      payload: {
        ...collectDiagnostics(settings, targetDocument),
        bootstrap: false,
        frameHref: targetUrl,
        contentScriptAlive: true
      }
    });
    if (settings?.enabled === false)
      continue;
    if (!isDouyinRpaAllowed(targetDocument, settings)) {
      clearConversationTask('历史咨询页不自动处理');
      void safeRuntimeMessage({ type: 'clearFrameSession' });
      setProcessingStatus('历史咨询页不自动处理，请切回当前咨询');
      continue;
    }
    scheduleUnreadConversation(settings, targetDocument);
    if (!settings.messageItemSelector)
      continue;
    const session = readSession(targetDocument, settings, targetUrl);
    const conversationId = session.conversationId;
    const customerId = session.customerId;
    // waiting/applying 期间允许短暂 ID 未对齐；只有 switching 卡住才按旧逻辑释放。
    if (conversationTask?.phase === 'switching'
      && !conversationMatchesTask(session, conversationTask, settings)
      && Date.now() - conversationTask.startedAt > 8000)
      clearConversationTask('已释放过期会话切换任务');
    const messageItems = settings.platform === 'douyin'
      ? queryDouyinMessageItems(targetDocument, settings)
      : queryAllDeep(targetDocument, settings.messageItemSelector);
    const outboundItems = queryAllDeep(targetDocument, settings.outboundMessageItemSelector || '.message-cell-container:has(.message-wrapper.right-message .text-message.shop-text)');
    const hasRealConversationFlag = hasRealConversation(session);
    if (!hasRealConversationFlag) {
      scheduleUnreadConversation(settings, targetDocument);
      continue;
    }
    if (!isAllowedConversation(settings, session, null)) {
      clearConversationTask(`已忽略非测试客户：${session.customerName || session.conversationId}`);
      void safeRuntimeMessage({ type: 'clearFrameSession' });
      setProcessingStatus(`已忽略非测试客户：${session.customerName || session.conversationId}`);
      continue;
    }
    // 预警通知等系统会话不参与 AI 回复，只负责触发切换到客户未读。
    if (settings.platform === 'douyin' && isDouyinSystemSessionName(session.customerName || session.conversationId)) {
      scheduleUnreadConversation(settings, targetDocument);
      continue;
    }
    // 抖音 URL/顶部昵称已切换但中间聊天区仍在 loading 或占位时，不读消息，避免串会话。
    if (settings.platform === 'douyin' && !isDouyinChatReady(targetDocument, settings)) {
      scheduleUnreadConversation(settings, targetDocument);
      continue;
    }
    if (settings.platform === 'douyin' && isDouyinPlaceholderName(session.conversationId) && !session.customerName) {
      scheduleUnreadConversation(settings, targetDocument);
      continue;
    }
    void safeRuntimeMessage({ type: 'session', payload: session });
    const isInitialConversationScan = !initializedConversations.has(`${session.shopId}:${conversationId}`);
    let scheduledUnreadCount = conversationTask && conversationMatchesTask(session, conversationTask, settings)
      ? conversationTask.unreadCount : 0;
    const cardUnreadCount = settings.platform === 'douyin'
      ? getDouyinCardUnreadCountForSession(targetDocument, settings, session)
      : 0;
    if (settings.platform === 'douyin' && cardUnreadCount > scheduledUnreadCount)
      scheduledUnreadCount = cardUnreadCount;
    scheduledUnreadCount = Math.min(Math.max(0, scheduledUnreadCount), 9);
    let inboundSent = 0;
    const processItems = (items, direction, textSelector) => {
      // 抖音：自动扫描阶段只关心最后 N 条（未读数），绝不把历史气泡当新消息连发。
      // 初次扫描仍会整页写入 seenMessages，只是不入队。
      let workItems = items;
      if (settings.platform === 'douyin' && direction === 'inbound' && !isInitialConversationScan) {
        const take = Math.max(1, scheduledUnreadCount || 1);
        workItems = items.slice(-take);
      }
      const contentOccurrence = new Map();
      workItems.forEach((item, index) => {
        const rawContent = settings.platform === 'douyin'
          ? textOfDouyinBubble(item)
          : textOf(item, textSelector);
        if (!rawContent)
          return;
        if (settings.platform === 'douyin' && (
          rawContent === '[暂不支持查看该类消息]'
          || rawContent.length <= 1
        ))
          return;
        // 入库与去重用去时间前缀后的正文，避免「11:16 / 11:36 同一句系统提示」换 ID 再进线。
        const content = settings.platform === 'douyin'
          ? stripDouyinTimePrefix(rawContent)
          : rawContent;
        if (!content)
          return;
        const occurrence = (contentOccurrence.get(content) || 0) + 1;
        contentOccurrence.set(content, occurrence);
        // occurrence 对整页 items 计数；切片后 index 不代表全局位置，改用以 0 起的 work index。
        const id = createStableId(conversationId, direction, content, index, settings.platform, item, occurrence);
        const contentKey = settings.platform === 'douyin'
          ? `${conversationId}:${direction}:${content}`
          : null;
        // 系统进线提示不是客户提问：只记 seen，切会话也不触发 RAG/欢迎语。
        if (settings.platform === 'douyin' && direction === 'inbound' && isDouyinSystemNoticeContent(rawContent)) {
          seenMessages.add(id);
          submittedInboundIds.add(id);
          if (contentKey)
            submittedInboundContents.add(contentKey);
          return;
        }
        const isTriggerUnread = direction === 'inbound' && scheduledUnreadCount > 0 && index === workItems.length - 1;
        // 未读角标常在回复后残留；只有「同正文从未提交过」才允许强制重提，避免旧消息换 ID 后二次回复。
        const forceUnreadResubmit = isTriggerUnread
          && cardUnreadCount > 0
          && !submittedInboundIds.has(id)
          && !(contentKey && submittedInboundContents.has(contentKey));
        if (seenMessages.has(id) && !forceUnreadResubmit)
          return;
        if (direction === 'inbound' && settings.platform === 'douyin'
          && classifyDouyinInboundEvolution(conversationId, content) === 'skip') {
          seenMessages.add(id);
          submittedInboundIds.add(id);
          if (contentKey)
            submittedInboundContents.add(contentKey);
          return;
        }
        // 同正文已成功入过队（例如切回话前已恢复过），角标残留也不再二次入库。
        if (settings.platform === 'douyin' && contentKey && submittedInboundContents.has(contentKey)
          && !forceUnreadResubmit) {
          seenMessages.add(id);
          return;
        }
        if (isInitialConversationScan && !isTriggerUnread) {
          seenMessages.add(id);
          return;
        }
        seenMessages.add(id);
        if (direction === 'inbound') {
          inboundSent += 1;
          submittedInboundIds.add(id);
          if (contentKey)
            submittedInboundContents.add(contentKey);
          if (settings.platform === 'douyin')
            lastDouyinInboundByConversation.set(conversationId, content);
          conversationTask = conversationTask || {
            expectedConversationId: conversationId,
            expectedCustomerName: session.customerName || conversationId,
            unreadCount: scheduledUnreadCount || 1,
            phase: 'waiting-draft',
            startedAt: Date.now()
          };
          setProcessingStatus(`AI 正在处理：${session.customerName || conversationId}`);
        }
        void safeRuntimeMessage({
          type: direction,
          requestId: crypto.randomUUID(),
          payload: {
            platform: session.platform,
            id,
            shopId: session.shopId,
            conversationId,
            customerId,
            customerName: session.customerName || item.getAttribute('data-customer-name') || undefined,
            content,
            aiGenerated: direction === 'outbound' && item.getAttribute('data-ai-generated') === 'true',
            createdAt: item.getAttribute('data-created-at') || new Date().toISOString()
          }
        });
      });
    };
    processItems(messageItems, 'inbound', settings.messageTextSelector);
    processItems(outboundItems, 'outbound', settings.outboundMessageTextSelector || '.text-message.shop-text');
    initializedConversations.add(`${session.shopId}:${conversationId}`);
    if (conversationTask && conversationMatchesTask(session, conversationTask, settings) && inboundSent > 0)
      conversationTask.phase = 'waiting-draft';
    scheduleUnreadConversation(settings, targetDocument);
  }
}

async function applyDraft(draft, expectedSession) {
  const settings = expectedSession?.platform
    ? await resolveSettings(expectedSession.pageUrl || location.href)
    : await resolveSettings(location.href);
  if (!settings?.replyInputSelector)
    return;
  if (settings.platform === 'douyin') {
    const hostDocument = getAccessibleDocuments().find((doc) => {
      const url = doc.location?.href || location.href;
      return globalThis.__customerAiPlatformProfiles?.detectPlatformFromUrl(url);
    }) || document;
    if (isDouyinHistoryTabActive(hostDocument)) {
      setProcessingStatus('历史咨询页不自动回复，请切回当前咨询');
      void safeRuntimeMessage({
        type: 'draft_send_result',
        payload: {
          platform: expectedSession?.platform,
          customerName: expectedSession?.customerName,
          conversationId: expectedSession?.conversationId,
          draftId: draft.id,
          riskLevel: draft.riskLevel,
          allowAutoSend: false,
          denyReason: 'history_tab',
          clicked: false,
          filledOnly: true,
          method: 'history-tab-blocked',
          content: draft.content
        }
      });
      return;
    }
  }
  // 草稿就绪后：无论当前停在哪一通，都先强制切到该草稿对应会话再回填/发送。
  const targetDocument = await ensureConversationForDraft(settings, expectedSession);
  if (!targetDocument) {
    setProcessingStatus(`切换失败，未找到目标会话：${expectedSession?.customerName || expectedSession?.conversationId || ''}`);
    void safeRuntimeMessage({
      type: 'draft_send_result',
      payload: {
        platform: expectedSession?.platform,
        customerName: expectedSession?.customerName,
        conversationId: expectedSession?.conversationId,
        draftId: draft.id,
        riskLevel: draft.riskLevel,
        allowAutoSend: false,
        denyReason: 'switch_failed',
        clicked: false,
        filledOnly: true,
        method: 'switch-failed',
        content: draft.content
      }
    });
    clearConversationTask('草稿投递前未能切换到目标会话');
    setTimeout(scanMessages, 500);
    return;
  }
  let input = settings.platform === 'douyin'
    ? queryDouyinReplyInput(targetDocument, settings)
    : queryOneDeep(targetDocument, settings.replyInputSelector);
  if (!input && settings.platform === 'douyin') {
    for (let attempt = 0; attempt < 6 && !input; attempt += 1) {
      await sleep(500);
      input = queryDouyinReplyInput(targetDocument, settings);
    }
  }
  if (!input) {
    setProcessingStatus('聊天区未就绪：未找到输入框');
    void safeRuntimeMessage({
      type: 'draft_send_result',
      payload: {
        platform: expectedSession?.platform,
        customerName: expectedSession?.customerName,
        conversationId: expectedSession?.conversationId,
        draftId: draft.id,
        riskLevel: draft.riskLevel,
        allowAutoSend: false,
        denyReason: 'chat_not_ready',
        clicked: false,
        filledOnly: true,
        method: 'chat-not-ready',
        content: draft.content
      }
    });
    clearConversationTask('聊天区未加载完成');
    setTimeout(scanMessages, 500);
    return;
  }
  const canAutoSend = settings.autoSend && draft.allowAutoSend && draft.riskLevel === 'low' && settings.sendButtonSelector;
  dispatchEditableInput(input, draft.content);
  if (settings.platform === 'douyin')
    await waitForDouyinSendReady(targetDocument, settings, input, 3500);
  // 自动发送必须同时满足扩展开关和服务端安全环境变量；默认永远只回填供人工确认。
  if (canAutoSend) {
    await sleep(400);
    const { clicked, method } = await attemptAutoSend(input, targetDocument, settings);
    setProcessingStatus(clicked
      ? `已自动回复：${expectedSession?.customerName || expectedSession?.conversationId || ''}`
      : `已回填但发送失败：${settings.sendButtonSelector}`);
    void safeRuntimeMessage({
      type: 'draft_send_result',
      payload: {
        platform: expectedSession?.platform,
        shopId: expectedSession?.shopId,
        conversationId: expectedSession?.conversationId,
        customerId: expectedSession?.customerId,
        customerName: expectedSession?.customerName,
        draftId: draft.id,
        riskLevel: draft.riskLevel,
        allowAutoSend: true,
        clicked,
        filledOnly: !clicked,
        method,
        content: draft.content
      }
    });
    releaseConversationTaskAfterDraft(expectedSession, settings, clicked ? 1500 : 600);
  } else {
    const skipReason = !settings.autoSend
      ? '弹窗未勾选自动发送'
      : draft.allowAutoSend !== true
        ? `服务端未授权自动发送${draft.denyReason ? `（${draft.denyReason}）` : ''}`
        : draft.riskLevel !== 'low'
          ? `风险等级 ${draft.riskLevel}，仅回填不自动发送`
          : !settings.sendButtonSelector
            ? '发送按钮选择器为空'
            : '条件未满足';
    setProcessingStatus(`已回填待确认：${skipReason}`);
    void safeRuntimeMessage({
      type: 'draft_send_result',
      payload: {
        platform: expectedSession?.platform,
        shopId: expectedSession?.shopId,
        conversationId: expectedSession?.conversationId,
        customerId: expectedSession?.customerId,
        customerName: expectedSession?.customerName,
        draftId: draft.id,
        riskLevel: draft.riskLevel,
        allowAutoSend: false,
        denyReason: draft.denyReason || skipReason,
        clicked: false,
        filledOnly: true,
        method: 'fill-only',
        content: draft.content
      }
    });
    releaseConversationTaskAfterDraft(expectedSession, settings, 600);
  }
}

/** 草稿到位：锁定 applying-draft，强制切到 draft.session 对应会话后再返回文档。 */
async function ensureConversationForDraft(settings, expectedSession) {
  const hint = expectedSession?.customerName
    || expectedSession?.conversationId
    || expectedSession?.customerId
    || '';
  conversationTask = {
    expectedConversationId: expectedSession?.conversationId || expectedSession?.customerId || hint,
    expectedCustomerName: expectedSession?.customerName || hint || undefined,
    unreadCount: conversationTask?.unreadCount || 1,
    phase: 'applying-draft',
    startedAt: Date.now()
  };
  setProcessingStatus(`草稿已就绪，切换会话：${expectedSession?.customerName || expectedSession?.conversationId || ''}`);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let targetDocument = findSessionDocument(settings, expectedSession);
    if (targetDocument) {
      if (settings.platform === 'douyin' && !isDouyinChatReady(targetDocument, settings)) {
        switchToConversation(settings, targetDocument, hint, { waitDraft: true });
        conversationTask.phase = 'applying-draft';
        await sleep(550);
        continue;
      }
      const input = settings.platform === 'douyin'
        ? queryDouyinReplyInput(targetDocument, settings)
        : queryOneDeep(targetDocument, settings.replyInputSelector);
      if (input || attempt >= 4)
        return targetDocument;
    }
    for (const candidate of getAccessibleDocuments()) {
      const targetUrl = candidate.location?.href || location.href;
      if (!globalThis.__customerAiPlatformProfiles?.detectPlatformFromUrl(targetUrl))
        continue;
      const candidateSettings = settings.platform
        ? settings
        : await resolveSettings(targetUrl);
      if (candidateSettings?.platform && expectedSession?.platform
        && candidateSettings.platform !== expectedSession.platform)
        continue;
      const switched = switchToConversation(
        candidateSettings || settings,
        candidate,
        hint || expectedSession?.conversationId || expectedSession?.customerId,
        { waitDraft: true }
      );
      if (switched) {
        conversationTask.phase = 'applying-draft';
        conversationTask.expectedConversationId = expectedSession?.conversationId || expectedSession?.customerId || hint;
        conversationTask.expectedCustomerName = expectedSession?.customerName || hint || undefined;
        break;
      }
    }
    await sleep(550);
  }
  return findSessionDocument(settings, expectedSession);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'applyDraft')
    void applyDraft(message.payload, message.session);
  if (message.type === 'rescan')
    void scanMessages();
  if (message.type === 'collectDomSnapshot') {
    sendResponse({ snapshot: buildDomSnapshot() });
    return true;
  }
  if (message.type === 'validateAiSelectors') {
    sendResponse(validateAiSelectors(message.selectors));
    return true;
  }
});

observer = new MutationObserver(() => {
  if (!isExtensionContextAlive()) {
    stopInvalidExtensionContext();
    return;
  }
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanMessages, 400);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
// 平台可能在父文档不变的情况下更新 iframe 内部 DOM，定时扫描用于覆盖这种变化。
scanInterval = setInterval(scanMessages, 1500);
void scanMessages();
void (async function bootstrapDiagnostics() {
  const platform = globalThis.__customerAiPlatformProfiles?.detectPlatformFromUrl(location.href);
  if (!platform)
    return;
  const settings = await resolveSettings(location.href).catch(() => null);
  void safeRuntimeMessage({
    type: 'diagnostics',
    payload: {
      pageUrl: location.href,
      frameTitle: document.title,
      platform,
      bootstrap: true,
      contentScriptAlive: true,
      settingsState: {
        enabled: settings?.enabled !== false,
        autoSwitchConversations: settings?.autoSwitchConversations === true,
        autoSend: settings?.autoSend === true
      },
      conversationCounts: {
        items: settings ? conversationItemsOf(document, settings).length : 0,
        unread: settings ? conversationItemsOf(document, settings).filter((item) => unreadCountOf(item, settings) > 0).length : 0,
        bootstrap: true
      }
    }
  });
})();
}
