// @ts-nocheck
/**
 * @file apps/api/src/rpa/mock-chat-server.ts
 * @module RPA 与 Chrome 插件
 * @description 3100 端口多会话 Mock 聊天页，支持随机消息和页面发送。
 * @see 联动关注：content.js 选择器调试。
 */
import { createServer } from 'node:http';

const port = Number(process.env.RPA_MOCK_PORT ?? 3100);
const host = process.env.RPA_MOCK_HOST ?? '0.0.0.0';

/**
 * 生成本地多会话 RPA 测试页。
 * 页面只模拟平台 DOM 和客户来消息，不直接调用 AI；监听、切换、回复仍由 Chrome 插件和 WebSocket Adapter 完成。
 */
function html(platform: 'douyin' | 'meituan') {
  const platformName = platform === 'douyin' ? '抖音来客' : '美团到店';
  const accent = platform === 'douyin' ? '#171717' : '#facc15';
  const headerColor = platform === 'douyin' ? '#fff' : '#111827';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${platformName} 多会话 RPA 测试台</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f5f7; color: #111827; }
    header { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: ${accent}; color: ${headerColor}; }
    .header-actions { display: flex; align-items: center; gap: 18px; }
    header label { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .rpa-state { min-width: 150px; font-size: 13px; text-align: right; }
    main { display: grid; grid-template-columns: 300px minmax(0, 1fr); height: calc(100vh - 56px); }
    aside { overflow: auto; border-right: 1px solid #d8dde6; background: #fff; }
    .aside-title { padding: 14px 16px 8px; color: #667085; font-size: 13px; }
    .chat-list-item { position: relative; width: 100%; min-height: 72px; padding: 12px 46px 12px 16px; border: 0; border-bottom: 1px solid #eef0f3; border-radius: 0; background: #fff; color: #111827; text-align: left; cursor: pointer; }
    .chat-list-item:hover, .chat-list-item.active { background: #f2f4f7; }
    .userinfo-username { display: block; margin-bottom: 5px; font-weight: 650; }
    .conversation-preview { overflow: hidden; color: #667085; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
    .mtd-badge { position: absolute; top: 24px; right: 16px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #ef4444; color: #fff; font-size: 12px; line-height: 20px; text-align: center; }
    .mtd-badge[hidden] { display: none; }
    .chat { display: grid; grid-template-rows: 58px minmax(0, 1fr) auto; min-width: 0; }
    .user-center { display: flex; align-items: center; padding: 0 20px; border-bottom: 1px solid #d8dde6; background: #fff; }
    .userinfo-name-show { font-weight: 700; }
    .messages { padding: 24px; overflow: auto; }
    .message-cell-container { margin-bottom: 14px; }
    .message-wrapper { display: flex; }
    .message-wrapper.right-message { justify-content: flex-end; }
    .text-message { max-width: 620px; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; line-height: 1.5; box-shadow: 0 1px 2px rgba(15, 23, 42, .06); }
    .right-message .text-message { border-color: #bfdbfe; background: #dbeafe; }
    .composer-wrap { display: grid; gap: 8px; padding: 14px; border-top: 1px solid #d8dde6; background: #fff; }
    .composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
    .composer.customer { border-bottom: 1px dashed #d8dde6; padding-bottom: 10px; }
    input, button { min-height: 40px; border: 1px solid #cfd5df; border-radius: 6px; font: inherit; }
    input { min-width: 0; padding: 0 12px; }
    button { padding: 0 14px; background: #111827; color: #fff; cursor: pointer; }
    .dzim-chat-input-container { min-height: 72px; padding: 12px; border: 1px solid #cfd5df; border-radius: 6px; background: #fff; outline: none; white-space: pre-wrap; }
    .dzim-chat-input-container:empty::before { color: #98a2b3; content: attr(data-placeholder); }
    .dzim-chat-input-send { display: flex; justify-content: flex-end; margin-top: 8px; }
    @media (max-width: 760px) { main { grid-template-columns: 220px minmax(0, 1fr); } }
  </style>
</head>
<body data-platform="${platform}">
  <header>
    <strong>${platformName} 多会话测试台</strong>
    <div class="header-actions"><span class="rpa-state" data-rpa-processing-status>等待新消息</span><label><input id="auto-incoming" type="checkbox" />持续模拟客户来消息</label></div>
  </header>
  <main>
    <aside>
      <div class="aside-title">会话客户</div>
      <div id="conversation-list" class="chat-list-item-wrapper"></div>
    </aside>
    <section class="chat">
      <div id="session-root" class="user-center" lx-mv="{}"><span id="customer-name" class="userinfo-name-show"></span></div>
      <div id="messages" class="messages" aria-live="polite"></div>
      <div class="composer-wrap">
        <form id="customer-composer" class="composer customer">
          <input id="customer-text" autocomplete="off" placeholder="向当前客户会话添加一条新消息" />
          <button type="submit">模拟来消息</button>
        </form>
        <form id="agent-composer">
          <pre class="dzim-chat-input-container" data-rpa-reply-input data-placeholder="插件会把建议回复填到这里" contenteditable="plaintext-only"></pre>
          <div class="dzim-chat-input-send"><button class="dzim-button dzim-button-primary" type="submit" data-rpa-send-button>发送</button></div>
        </form>
      </div>
    </section>
  </main>
  <script>
    const platform = document.body.dataset.platform;
    const shopId = platform + '-mock-shop-001';
    const samples = [
      '周末可以使用团购券吗？', '你们今天几点关门？', '附近停车方便吗？', '需要提前预约吗？',
      '羽绒服短款多少钱？', '运动鞋清洗需要几天？', '可以上门取衣服吗？', '上门取送怎么收费？',
      '普通衣服多久能洗好？', '节假日正常营业吗？', '门店具体地址在哪里？', '最晚几点可以送洗？',
      '团购券可以叠加使用吗？', '没有预约可以直接到店吗？', '白色运动鞋可以精洗吗？', '可以开电子发票吗？',
      '油渍时间久了还能处理吗？', '加急最快多久可以取？', '真丝衣服可以清洗吗？', '取衣服需要带什么凭证？',
      '洗好的衣服可以保管多久？', '窗帘清洗怎么收费？', '羊毛大衣一般几天洗好？', '停车场是免费的吗？'
    ];
    const conversations = [
      { id: platform + '-customer-001', name: '林女士', unread: 0, messages: [] },
      { id: platform + '-customer-002', name: '陈先生', unread: 0, messages: [] },
      { id: platform + '-customer-003', name: '周女士', unread: 0, messages: [] },
      { id: platform + '-customer-004', name: '王先生', unread: 0, messages: [] }
    ];
    let activeId = conversations[0].id;
    let autoTimer;
    let autoIncomingEnabled = false;
    const recentSamples = [];
    const list = document.querySelector('#conversation-list');
    const messages = document.querySelector('#messages');
    const sessionRoot = document.querySelector('#session-root');
    const customerName = document.querySelector('#customer-name');
    const customerInput = document.querySelector('#customer-text');
    const replyInput = document.querySelector('[data-rpa-reply-input]');

    function activeConversation() {
      return conversations.find((item) => item.id === activeId);
    }

    function renderList() {
      list.replaceChildren(...conversations.map((conversation) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-list-item' + (conversation.id === activeId ? ' active' : '');
        button.dataset.customerId = conversation.id;
        button.dataset.conversationId = conversation.id;
        button.dataset.unreadCount = String(conversation.unread);
        const last = conversation.messages.at(-1)?.content || '等待客户咨询';
        button.innerHTML = '<span class="userinfo-username"></span><div class="conversation-preview"></div><span class="mtd-badge"></span>';
        button.querySelector('.userinfo-username').textContent = conversation.name;
        button.querySelector('.conversation-preview').textContent = last;
        const badge = button.querySelector('.mtd-badge');
        badge.textContent = String(conversation.unread);
        badge.hidden = conversation.unread === 0;
        button.addEventListener('click', () => switchConversation(conversation.id));
        return button;
      }));
    }

    function renderMessages() {
      const conversation = activeConversation();
      customerName.textContent = conversation.name;
      sessionRoot.setAttribute('lx-mv', JSON.stringify({ lab: { shopId, userId: conversation.id } }));
      messages.replaceChildren(...conversation.messages.map((message) => {
        const cell = document.createElement('div');
        cell.className = 'message-cell-container';
        cell.dataset.messageid = message.id;
        cell.dataset.createdAt = message.createdAt;
        cell.innerHTML = '<div class="message-wrapper"><div class="message-detail"><div class="message-container"><div class="text-message"></div></div></div></div>';
        const wrapper = cell.querySelector('.message-wrapper');
        const text = cell.querySelector('.text-message');
        wrapper.classList.add(message.direction === 'inbound' ? 'left-message' : 'right-message');
        text.classList.add(message.direction === 'inbound' ? 'normal-text' : 'shop-text');
        text.textContent = message.content;
        return cell;
      }));
      messages.scrollTop = messages.scrollHeight;
    }

    function switchConversation(id) {
      activeId = id;
      activeConversation().unread = 0;
      replyInput.textContent = '';
      renderList();
      renderMessages();
    }

    function addMessage(conversation, direction, content) {
      conversation.messages.push({ id: crypto.randomUUID(), direction, content, createdAt: new Date().toISOString() });
      if (direction === 'inbound' && conversation.id !== activeId)
        conversation.unread += 1;
      renderList();
      if (conversation.id === activeId)
        renderMessages();
    }

    function simulateIncoming() {
      // 只给没有未读积压的非当前会话发消息，生成速度不能超过串行 AI 的处理能力。
      const candidates = conversations.filter((item) => item.id !== activeId && item.unread === 0);
      if (!candidates.length)
        return;
      const conversation = candidates[Math.floor(Math.random() * candidates.length)];
      const available = samples.filter((content) => content !== conversation.lastSimulated && !recentSamples.includes(content));
      const pool = available.length ? available : samples.filter((content) => content !== conversation.lastSimulated);
      const content = pool[Math.floor(Math.random() * pool.length)];
      conversation.lastSimulated = content;
      recentSamples.push(content);
      if (recentSamples.length > 10)
        recentSamples.shift();
      addMessage(conversation, 'inbound', content);
    }

    function scheduleNextIncoming() {
      clearTimeout(autoTimer);
      if (!autoIncomingEnabled)
        return;
      // 30-70 秒随机空档更接近真人咨询，也给 Embedding + OpenClaw 留出完整处理时间。
      const delay = 30000 + Math.floor(Math.random() * 40001);
      autoTimer = setTimeout(() => {
        simulateIncoming();
        scheduleNextIncoming();
      }, delay);
    }

    document.querySelector('#customer-composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const value = customerInput.value.trim();
      if (!value) return;
      addMessage(activeConversation(), 'inbound', value);
      customerInput.value = '';
    });

    document.querySelector('#agent-composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const value = replyInput.textContent.trim();
      if (!value) return;
      // 发送必须经过页面原生按钮事件，插件不能直接伪造一个已发送气泡。
      addMessage(activeConversation(), 'outbound', value);
      replyInput.textContent = '';
    });

    document.querySelector('#auto-incoming').addEventListener('change', (event) => {
      autoIncomingEnabled = event.target.checked;
      scheduleNextIncoming();
    });

    conversations.forEach((conversation, index) => addMessage(conversation, 'outbound', index === 0 ? '您好，请问有什么可以帮您？' : '您好。'));
    renderList();
    renderMessages();
  </script>
</body>
</html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const platform = url.searchParams.get('platform') === 'meituan' ? 'meituan' : 'douyin';
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html(platform));
});

server.listen(port, host, () => {
  console.log(`RPA mock chat server listening at http://127.0.0.1:${port}?platform=douyin`);
  console.log(`RPA mock chat server listening at http://127.0.0.1:${port}?platform=meituan`);
  console.log(`RPA mock chat server bound on ${host}:${port}`);
});
