// @ts-nocheck
import { createServer } from 'node:http';
const port = Number(process.env.RPA_MOCK_PORT ?? 3100);
const host = process.env.RPA_MOCK_HOST ?? '0.0.0.0';
// 生成本地 RPA 测试页面。
// 它不是正式管理后台，而是用稳定 DOM 模拟抖音/美团商家客服页面，方便在没有真实账号时验证 watcher 链路。
function html(platform) {
    const platformName = platform === 'douyin' ? '抖音来客' : '美团到店';
    const accent = platform === 'douyin' ? '#111827' : '#facc15';
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${platformName} RPA 测试后台</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f3f4f6; color: #111827; }
    header { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: ${accent}; color: ${platform === 'douyin' ? '#fff' : '#111827'}; }
    main { display: grid; grid-template-columns: 280px 1fr; height: calc(100vh - 56px); }
    aside { border-right: 1px solid #d1d5db; background: #fff; padding: 14px; }
    .thread { width: 100%; border: 1px solid #d1d5db; background: #f9fafb; border-radius: 8px; padding: 12px; text-align: left; }
    .chat { display: grid; grid-template-rows: 1fr auto; min-width: 0; }
    .messages { padding: 24px; overflow: auto; }
    .msg { max-width: 620px; margin: 0 0 14px; padding: 10px 12px; border-radius: 8px; line-height: 1.5; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
    .inbound { background: #fff; border: 1px solid #e5e7eb; }
    .outbound { margin-left: auto; background: #dbeafe; border: 1px solid #bfdbfe; }
    .outbound.warning { background: #fef3c7; border-color: #fde68a; }
    .meta { margin-bottom: 4px; color: #6b7280; font-size: 12px; }
    .reason { margin-top: 6px; color: #92400e; font-size: 12px; }
    .composer-wrap { display: grid; gap: 8px; padding: 14px; border-top: 1px solid #d1d5db; background: #fff; }
    .composer { display: grid; grid-template-columns: 1fr auto; gap: 10px; }
    .composer.agent { border-top: 1px dashed #d1d5db; padding-top: 8px; }
    input, button { height: 40px; border-radius: 6px; border: 1px solid #d1d5db; font: inherit; }
    input { padding: 0 12px; }
    button { padding: 0 14px; background: #111827; color: #fff; cursor: pointer; }
    .quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .quick button { height: 34px; background: #f9fafb; color: #111827; }
  </style>
</head>
<body data-platform="${platform}" data-shop-id="shop-demo" data-conversation-id="${platform}-mock-conv-001" data-customer-id="${platform}-mock-user-001">
  <header>
    <strong>${platformName} 商家客服后台</strong>
    <span>RPA Mock</span>
  </header>
  <main>
    <aside>
      <button class="thread">
        <strong>测试客户</strong>
        <div>最近咨询：套餐规则</div>
      </button>
      <div class="quick">
        <button type="button" data-quick="周末可以用吗">周末可以用吗</button>
        <button type="button" data-quick="你们营业时间几点">营业时间</button>
        <button type="button" data-quick="我要退款">退款风控</button>
      </div>
    </aside>
    <section class="chat">
      <div id="messages" class="messages" aria-live="polite">
        <article class="msg outbound">
          <div class="meta">商家客服</div>
          您好，请问有什么可以帮您？
        </article>
      </div>
      <div class="composer-wrap">
        <form id="customer-composer" class="composer">
          <input id="customer-text" autocomplete="off" placeholder="在这里模拟客户发来的消息" />
          <button type="submit">添加客户消息</button>
        </form>
        <form id="agent-composer" class="composer agent">
          <input id="agent-text" data-rpa-reply-input autocomplete="off" placeholder="商家回复输入框，RPA 会填这里" />
          <button type="submit" data-rpa-send-button>发送商家回复</button>
        </form>
      </div>
    </section>
  </main>
  <script>
    const messages = document.querySelector('#messages');
    const customerInput = document.querySelector('#customer-text');
    const customerForm = document.querySelector('#customer-composer');
    const agentInput = document.querySelector('#agent-text');
    const agentForm = document.querySelector('#agent-composer');

    function addInbound(content) {
      const id = crypto.randomUUID();
      const item = document.createElement('article');
      item.className = 'msg inbound';
      item.dataset.messageId = id;
      item.dataset.customerName = '测试客户';
      item.dataset.createdAt = new Date().toISOString();
      item.innerHTML = '<div class="meta">测试客户</div><div class="content"></div>';
      item.querySelector('.content').textContent = content;
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
    }

    // 模拟商家侧回复气泡。
    // mock 页面展示的是草稿/建议回复，真实平台上线时仍要由风控和人工审核决定是否发送。
    function addOutbound(content, label, reason) {
      const item = document.createElement('article');
      item.className = reason ? 'msg outbound warning' : 'msg outbound';
      item.dataset.replyId = crypto.randomUUID();
      item.innerHTML = '<div class="meta"></div><div class="content"></div>';
      item.querySelector('.meta').textContent = label || 'OpenClaw 自动回复';
      item.querySelector('.content').textContent = content;
      if (reason) {
        const reasonNode = document.createElement('div');
        reasonNode.className = 'reason';
        reasonNode.textContent = reason;
        item.appendChild(reasonNode);
      }
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
    }

    customerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = customerInput.value.trim();
      if (!value) return;
      addInbound(value);
      customerInput.value = '';
    });

    agentForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = agentInput.value.trim();
      if (!value) return;
      // 真实 RPA sender 的目标就是走这类页面原生发送流程，而不是直接改 DOM。
      addOutbound(value, 'RPA 已点击发送');
      agentInput.value = '';
    });

    document.querySelectorAll('[data-quick]').forEach((button) => {
      button.addEventListener('click', () => addInbound(button.dataset.quick));
    });
  </script>
</body>
</html>`;
}
const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const platform = url.searchParams.get('platform') === 'meituan' ? 'meituan' : 'douyin';
    // 这个页面刻意模拟商家后台 DOM，供 RPA watcher 读取消息节点。
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html(platform));
});
server.listen(port, host, () => {
    // 默认监听 0.0.0.0，方便手机或其他电脑通过局域网 IP 访问 mock 商家后台。
    // 如果只想本机访问，可以设置 RPA_MOCK_HOST=127.0.0.1。
    console.log(`RPA mock chat server listening at http://127.0.0.1:${port}?platform=douyin`);
    console.log(`RPA mock chat server listening at http://127.0.0.1:${port}?platform=meituan`);
    console.log(`RPA mock chat server bound on ${host}:${port}`);
});
