/**
 * @file extensions/customer-ai-rpa/popup.js
 * @module RPA 与 Chrome 插件
 * @description 扩展配置持久化、连接状态和 AI 选择器识别。
 * @see 联动关注：Chrome storage API、platform-profiles.js。
 */
const fields = ['shopId', 'messageItemSelector', 'messageTextSelector', 'replyInputSelector', 'sendButtonSelector', 'enabled', 'autoSwitchConversations', 'autoSend'];
let activePlatform = 'meituan';

function platformLabel(platform) {
  return platform === 'douyin' ? '抖音来客' : '美团经营宝';
}

async function resolveActivePlatform(tab) {
  if (!tab?.url)
    return 'meituan';
  return globalThis.__customerAiPlatformProfiles?.detectPlatformFromUrl(tab.url) || 'meituan';
}

async function loadProfileValues(platform, values) {
  const profile = values.platformProfiles?.[platform] || {};
  const merged = globalThis.__customerAiPlatformProfiles?.mergePlatformSettings(values, platform, values.activeTabUrl)
    || { ...profile, enabled: values.enabled, autoSend: values.autoSend, autoSwitchConversations: values.autoSwitchConversations };
  for (const field of fields) {
    const element = document.getElementById(field);
    if (!element)
      continue;
    if (element.type === 'checkbox')
      element.checked = Boolean(merged[field]);
    else
      element.value = merged[field] ?? '';
  }
}

async function load() {
  await chrome.runtime.sendMessage({ type: 'ensureConnection' }).catch(() => undefined);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activePlatform = await resolveActivePlatform(tab);
  const values = await chrome.storage.local.get();
  values.activeTabUrl = tab?.url || '';
  const runtimeStatus = await chrome.runtime.sendMessage({ type: 'getStatus' }).catch(() => null);
  const apiStatus = await fetch('http://127.0.0.1:3001/rpa/extension/status')
    .then((response) => response.json())
    .catch(() => null);
  const currentSession = runtimeStatus?.sessions?.find((item) => item.platform === activePlatform)
    || runtimeStatus?.sessions?.at(-1)
    || apiStatus?.sessions?.find((item) => item.platform === activePlatform)
    || apiStatus?.sessions?.at(-1);
  if (currentSession?.shopId && currentSession.shopId !== 'default-shop')
    values.shopId = currentSession.shopId;
  await loadProfileValues(activePlatform, values);
  const platformHint = document.getElementById('platformHint');
  if (platformHint)
    platformHint.textContent = `当前页面：${platformLabel(activePlatform)}（美团与抖音可同时开标签页，配置按页面分别保存）`;
  const status = document.getElementById('status');
  const serverAutoSend = apiStatus?.rpaAutoSendEnabled === true;
  const base = values.connectionState === 'connected'
    ? (currentSession?.shopId ? `已连接 · ${currentSession.shopId}` : '已连接本地服务')
    : '本地服务未连接';
  status.textContent = values.connectionState === 'connected'
    ? `${base} · 服务端自动发送${serverAutoSend ? '开' : '关'}`
    : base;
  status.style.color = values.connectionState === 'connected' ? '#067647' : '#b54708';
  if (values.connectionState === 'connected' && values.autoSend && !serverAutoSend) {
    const resultNode = document.getElementById('ai-result');
    resultNode.style.display = 'block';
    resultNode.className = 'error';
    resultNode.textContent = '弹窗已开自动发送，但服务端 RPA_AUTO_SEND_ENABLED=false。请确认 .env 后重启服务。';
  }
  const sendInput = document.getElementById('sendButtonSelector');
  if (activePlatform === 'meituan' && sendInput?.value && String(sendInput.value).includes('not-configured')) {
    sendInput.value = '.dzim-chat-input-send > button.dzim-button-primary';
    const resultNode = document.getElementById('ai-result');
    resultNode.style.display = 'block';
    resultNode.className = 'error';
    resultNode.textContent = '检测到占位发送选择器，已替换为经营宝真实按钮；请勾选“允许自动点击发送”后点保存';
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const values = await chrome.storage.local.get();
  const profile = {};
  for (const field of fields) {
    const element = document.getElementById(field);
    if (field === 'enabled' || field === 'autoSwitchConversations' || field === 'autoSend')
      values[field] = element.type === 'checkbox' ? element.checked : element.value.trim();
    else
      profile[field] = element.value.trim();
  }
  values.platformProfiles = values.platformProfiles || {};
  values.platformProfiles[activePlatform] = {
    ...globalThis.__customerAiPlatformProfiles?.PLATFORM_PROFILES?.[activePlatform],
    ...values.platformProfiles[activePlatform],
    ...profile,
    platform: activePlatform
  };
  if (activePlatform === 'meituan')
    Object.assign(values, profile);
  await chrome.storage.local.set(values);
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
  window.close();
});

document.getElementById('autoSend').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ autoSend: event.target.checked });
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
  const resultNode = document.getElementById('ai-result');
  resultNode.style.display = 'block';
  resultNode.className = event.target.checked ? 'error' : '';
  resultNode.textContent = event.target.checked
    ? '自动发送已开启，仅 low 风险、会话一致且通过发送冷却的草稿会点击发送'
    : '自动发送已关闭，回复只回填输入框';
});

document.getElementById('autoSwitchConversations').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ autoSwitchConversations: event.target.checked });
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
});

document.getElementById('rescan').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id)
    chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => undefined);
});

document.getElementById('auto-config').addEventListener('click', async () => {
  const button = document.getElementById('auto-config');
  const resultNode = document.getElementById('ai-result');
  button.disabled = true;
  button.textContent = '分析中...';
  resultNode.style.display = 'block';
  resultNode.className = '';
  resultNode.textContent = '正在采集脱敏 DOM 并请求 OpenClaw';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id)
      throw new Error('未找到当前客服标签页');
    const collected = await chrome.tabs.sendMessage(tab.id, { type: 'collectDomSnapshot' });
    const response = await fetch('http://127.0.0.1:3001/rpa/extension/analyze-dom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(collected)
    });
    const analyzed = await response.json();
    if (!response.ok || !analyzed.ok)
      throw new Error(analyzed.error || `HTTP ${response.status}`);
    const validation = await chrome.tabs.sendMessage(tab.id, { type: 'validateAiSelectors', selectors: analyzed.selectors });
    if (!validation?.valid)
      throw new Error(`候选选择器未通过本页验证：${JSON.stringify(validation?.counts || validation?.error)}`);
    const stored = await chrome.storage.local.get();
    stored.platformProfiles = stored.platformProfiles || {};
    stored.platformProfiles[activePlatform] = {
      ...stored.platformProfiles[activePlatform],
      ...analyzed.selectors,
      platform: activePlatform
    };
    await chrome.storage.local.set({ ...stored, settingsVersion: 8 });
    for (const field of fields) {
      if (analyzed.selectors[field] && document.getElementById(field))
        document.getElementById(field).value = analyzed.selectors[field];
    }
    chrome.runtime.sendMessage({ type: 'settingsChanged' });
    const sourceLabel = analyzed.source === 'openclaw' ? 'OpenClaw' : '本地结构化兜底';
    resultNode.textContent = `${sourceLabel} 候选验证通过：客户消息 ${validation.counts.messageItems} 条，输入框 ${validation.counts.inputHits} 个`;
  } catch (error) {
    resultNode.className = 'error';
    resultNode.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
    button.textContent = 'AI 自动识别';
  }
});

void load();
