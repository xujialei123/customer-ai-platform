const fields = ['shopId', 'messageItemSelector', 'messageTextSelector', 'replyInputSelector', 'sendButtonSelector', 'enabled', 'autoSwitchConversations', 'autoSend'];

async function load() {
  // 打开弹窗时先唤醒后台连接，再用当前会话覆盖安装时的 default-shop 展示值。
  // 打开面板时立即唤醒后台连接；服务刚恢复时无需等待下一次 30 秒 alarm。
  await chrome.runtime.sendMessage({ type: 'ensureConnection' }).catch(() => undefined);
  const values = await chrome.storage.local.get();
  const runtimeStatus = await chrome.runtime.sendMessage({ type: 'getStatus' }).catch(() => null);
  const currentSession = runtimeStatus?.sessions?.at(-1);
  if (currentSession?.shopId && currentSession.shopId !== 'default-shop')
    values.shopId = currentSession.shopId;
  for (const field of fields) {
    const element = document.getElementById(field);
    if (element.type === 'checkbox')
      element.checked = Boolean(values[field]);
    else
      element.value = values[field] ?? '';
  }
  const status = document.getElementById('status');
  status.textContent = values.connectionState === 'connected'
    ? (currentSession?.shopId ? `已连接 · ${currentSession.shopId}` : '已连接本地服务')
    : '本地服务未连接';
  status.style.color = values.connectionState === 'connected' ? '#067647' : '#b54708';
}

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  for (const field of fields) {
    const element = document.getElementById(field);
    values[field] = element.type === 'checkbox' ? element.checked : element.value.trim();
  }
  await chrome.storage.local.set(values);
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
  window.close();
});

document.getElementById('autoSend').addEventListener('change', async (event) => {
  // 自动发送属于高风险开关，变更后立即持久化并重新同步服务端，不能依赖用户再点击“保存配置”。
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
  // 多会话调度也需要显式授权并持久化，扩展重启后继续沿用操作员的选择。
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
      throw new Error('未找到当前经营宝标签页');
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
    await chrome.storage.local.set({ ...analyzed.selectors, settingsVersion: 2 });
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
