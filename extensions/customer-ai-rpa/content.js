/**
 * @file extensions/customer-ai-rpa/content.js
 * @module RPA 与 Chrome 插件
 * @description DOM/Shadow DOM 消息采集、未读队列、会话切换、回填和发送。
 * @see 联动关注：平台 DOM 变化与串话防护。
 */
if (!globalThis.__customerAiRpaInjected) {
globalThis.__customerAiRpaInjected = true;
const seenMessages = new Set();
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

function createStableId(conversationId, direction, content, index) {
  // 平台缺少 messageId 时才使用兜底 ID；数据库仍会做第二层去重。
  // 页面未暴露消息 ID 时使用会话、文本和位置组成兜底 ID，服务端仍会进行数据库二次去重。
  return `${conversationId}:${direction}:${index}:${content}`;
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
  const nodes = [];
  const candidateSelector = '.message-cell-container,.message-wrapper,.text-message,[contenteditable],button,.dzim-chat-input-send,.user-center,.userinfo-name-show,[lx-mv]';
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
  return { platform: 'meituan', nodes, counts: { documents: getAccessibleDocuments().length } };
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
      messageItems: settings.messageItemSelector ? queryAllDeep(targetDocument, settings.messageItemSelector).length : 0,
      messageTexts: settings.messageTextSelector ? queryAllDeep(targetDocument, settings.messageTextSelector).length : 0,
      replyInputs: settings.replyInputSelector ? queryAllDeep(targetDocument, settings.replyInputSelector).length : 0,
      sendButtons: settings.sendButtonSelector ? queryAllDeep(targetDocument, settings.sendButtonSelector).length : 0
    },
    editables: queryAllDeep(targetDocument, '[contenteditable="true"],[contenteditable="plaintext-only"],textarea').slice(0, 10).map(selectorShape),
    sendControls: queryAllDeep(targetDocument, 'button,[role="button"]')
      .filter((element) => /发送/.test(element.textContent ?? '')).slice(0, 10).map(selectorShape),
    repeatedClasses: [...classCounts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 30)
  };
}

function unreadCountOf(item, settings) {
  // 平台角标可能只显示红点，也可能显示数字；红点按一条未读处理，避免整条会话永远遗漏。
  const badge = item.querySelector(settings.conversationUnreadSelector || '.mtd-badge');
  if (!badge || badge.hidden || getComputedStyle(badge).display === 'none')
    return 0;
  const explicitCount = Number(item.getAttribute('data-unread-count'));
  if (Number.isFinite(explicitCount) && explicitCount > 0)
    return explicitCount;
  const textCount = Number.parseInt(badge.textContent?.trim() || '', 10);
  return Number.isFinite(textCount) && textCount > 0 ? textCount : 1;
}

function conversationIdOf(item) {
  return item.getAttribute('data-conversation-id')
    || item.getAttribute('data-customer-id')
    || item.getAttribute('data-user-id')
    || item.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')
    || '';
}

function setProcessingStatus(text) {
  // Mock 页面提供状态占位；真实平台没有该节点时静默跳过，不向经营宝 DOM 注入额外 UI。
  for (const targetDocument of getAccessibleDocuments()) {
    const status = queryOneDeep(targetDocument, '[data-rpa-processing-status]');
    if (status)
      status.textContent = text;
  }
}

function scheduleUnreadConversation(settings) {
  // 调度器严格串行：当前草稿尚未回填时不切换，防止多个客户共用一个输入框造成串话。
  if (!settings.autoSwitchConversations || conversationTask)
    return;
  for (const targetDocument of getAccessibleDocuments()) {
    const input = settings.replyInputSelector ? queryOneDeep(targetDocument, settings.replyInputSelector) : null;
    if (input?.textContent?.trim() || input?.value?.trim())
      continue;
    const unreadItem = queryAllDeep(targetDocument, settings.conversationItemSelector || '.chat-list-item')
      .find((item) => unreadCountOf(item, settings) > 0);
    if (!unreadItem)
      continue;
    const expectedConversationId = conversationIdOf(unreadItem);
    conversationTask = {
      expectedConversationId,
      unreadCount: unreadCountOf(unreadItem, settings),
      phase: 'switching',
      startedAt: Date.now()
    };
    setProcessingStatus('正在切换未读会话');
    // 使用页面真实点击事件切换客户，保持与真实商家后台行为一致。
    unreadItem.click();
    schedulerTimer = setTimeout(() => {
      // 页面结构变化或网络卡顿时释放任务，后续扫描可重新发现仍未处理的红点。
      // OpenClaw + Embedding 在本机可能超过 30 秒，过早切换会让返回草稿失去原会话投递目标。
      if (conversationTask?.startedAt && Date.now() - conversationTask.startedAt >= 120000)
        conversationTask = null;
    }, 121000);
    return;
  }
}

async function scanMessages() {
  // 首次进入客户会话只建立历史基线，之后新增的左右消息才分别进入 inbound/outbound。
  if (!isExtensionContextAlive()) {
    stopInvalidExtensionContext();
    return;
  }
  let settings;
  try {
    settings = await chrome.storage.local.get();
  } catch {
    stopInvalidExtensionContext();
    return;
  }
  if (!settings.enabled || !settings.messageItemSelector)
    return;
  for (const targetDocument of getAccessibleDocuments()) {
    const targetUrl = targetDocument.location?.href || location.href;
    const session = readMeituanSession(targetDocument, settings, targetUrl);
    const conversationId = session.conversationId;
    const customerId = session.customerId;
    void safeRuntimeMessage({ type: 'diagnostics', payload: collectDiagnostics(settings, targetDocument) });
    const messageItems = queryAllDeep(targetDocument, settings.messageItemSelector);
    const outboundItems = queryAllDeep(targetDocument, settings.outboundMessageItemSelector || '.message-cell-container:has(.message-wrapper.right-message .text-message.shop-text)');
    const hasRealConversation = session.shopId !== 'default-shop'
      && !['经营宝聊天页', '/dzim-workbench-pc/index.html'].includes(session.conversationId);
    // 外层壳页面没有真实 userId，不能注册为会话，否则旧草稿可能被错误回填到当前客户输入框。
    if (!hasRealConversation)
      continue;
    void safeRuntimeMessage({ type: 'session', payload: session });
    const isInitialConversationScan = !initializedConversations.has(`${session.shopId}:${conversationId}`);
    const scheduledUnreadCount = conversationTask
      && (!conversationTask.expectedConversationId || conversationTask.expectedConversationId === conversationId)
      ? conversationTask.unreadCount : 0;
    let inboundSent = 0;
    const processItems = (items, direction, textSelector) => items.forEach((item, index) => {
      const content = textOf(item, textSelector);
      const id = item.getAttribute('data-messageid') || item.getAttribute('data-message-id') || createStableId(conversationId, direction, content, index);
      if (!content || seenMessages.has(id))
        return;
      seenMessages.add(id);
      // 第一次进入某个客户会话时只建立历史基线；后续新出现的 messageId 才进入 AI 回复链路。
      // 自动切入一个从未打开过的客户时，只提交角标对应的最后 N 条未读，不能把全部历史记录送给 AI。
      // 连续未读通常是客户拆成多句发送；只用最新一条触发回复，避免同一客户瞬间收到多份 AI 回答。
      const isScheduledUnread = direction === 'inbound' && scheduledUnreadCount > 0 && index === items.length - 1;
      if (isInitialConversationScan && !isScheduledUnread)
        return;
      if (direction === 'inbound') {
        inboundSent += 1;
        conversationTask = conversationTask || {
          expectedConversationId: conversationId,
          unreadCount: 1,
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
    processItems(messageItems, 'inbound', settings.messageTextSelector);
    processItems(outboundItems, 'outbound', settings.outboundMessageTextSelector || '.text-message.shop-text');
    initializedConversations.add(`${session.shopId}:${conversationId}`);
    if (conversationTask && (!conversationTask.expectedConversationId || conversationTask.expectedConversationId === conversationId) && inboundSent > 0)
      conversationTask.phase = 'waiting-draft';
  }
  scheduleUnreadConversation(settings);
}

async function applyDraft(draft, expectedSession) {
  // 回填前重新读取当前 shopId/userId；标签页相同但客户不同也必须拒绝，防止串话。
  const settings = await chrome.storage.local.get();
  if (!settings.replyInputSelector)
    return;
  const targetDocument = getAccessibleDocuments().find((candidate) => {
    const current = readMeituanSession(candidate, settings, candidate.location?.href || location.href);
    return current.shopId === expectedSession?.shopId && current.conversationId === expectedSession?.conversationId;
  });
  if (!targetDocument)
    return;
  const input = queryOneDeep(targetDocument, settings.replyInputSelector);
  if (!input)
    return;
  const canAutoSend = settings.autoSend && draft.allowAutoSend && draft.riskLevel === 'low' && settings.sendButtonSelector;
  if (settings.autoSwitchConversations && settings.autoSend && !canAutoSend) {
    // 全自动队列遇到转人工草稿时不能占住输入框，也不能误发；草稿继续保存在服务端供后台人工处理。
    if (conversationTask && conversationTask.expectedConversationId === expectedSession?.conversationId) {
      clearTimeout(schedulerTimer);
      conversationTask = null;
      setProcessingStatus('已转人工，继续等待新消息');
      setTimeout(scanMessages, 500);
    }
    return;
  }
  input.focus();
  input.textContent = draft.content;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft.content }));
  // 自动发送必须同时满足扩展开关和服务端安全环境变量；默认永远只回填供人工确认。
  if (canAutoSend) {
    queryOneDeep(input.ownerDocument, settings.sendButtonSelector)?.click();
    setProcessingStatus(`已自动回复：${expectedSession?.customerName || expectedSession?.conversationId || ''}`);
  }
  // 当前客户已经拿到草稿后才释放串行锁；下一轮扫描才允许切换到另一个未读客户。
  if (conversationTask && conversationTask.expectedConversationId === expectedSession?.conversationId) {
    clearTimeout(schedulerTimer);
    conversationTask = null;
    setTimeout(scanMessages, 500);
  }
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
}
