<!-- 文件索引注释（不影响 Markdown 渲染）
  @file extensions/customer-ai-rpa/README.md
  @module RPA 与 Chrome 插件
  @description 扩展安装、测试步骤和安全注意事项。
  @see 联动关注：插件行为变化时同步更新。
-->
# 客服中台 Chrome RPA 扩展

该扩展运行在用户正常使用的 Chrome 中，不负责登录、不读取密码、不导出 Cookie。它只在已登录的经营宝页面中采集配置选择器命中的客户消息，并通过本机 WebSocket 发送到客服中台。

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录 `extensions/customer-ai-rpa`。
5. 正常打开并登录经营宝，然后点击扩展图标配置真实 DOM 选择器。

项目默认的 `pnpm dev` 会启动系统 Chrome。该浏览器使用 `.sessions/extension-chrome` 持久目录，不是 Playwright 临时浏览器；首次在自动打开的 `chrome://extensions` 加载本目录后，插件设置和网页登录态都能跨重启保留。修改扩展源码后仍需在扩展管理页点击一次“重新加载”。

服务端状态接口：`http://127.0.0.1:3001/rpa/extension/status`。

## 无真实账号的多会话测试

1. 执行 `pnpm dev`，打开 `http://127.0.0.1:3100/?platform=meituan` 或 `?platform=douyin`。
2. 在 `chrome://extensions/` 重新加载本扩展，确保 `0.2.2` 的本地页面权限生效。
3. 打开扩展面板，启用“页面监听”和“自动处理未读会话”。
4. 若需要完整无人干预演示，再单独启用“允许自动点击发送”；否则插件会在第一条草稿回填后停住，等待人工确认。
5. 在测试页开启“持续模拟客户来消息”。插件会读取左侧未读角标、串行点击客户、经本地 WebSocket 请求回复，并回填当前客户输入框。

多会话调度不会把全部历史消息重新提交给 AI。首次自动打开某个客户时，只使用最新一条未读消息触发回复；草稿尚未返回或输入框已有人工内容时不会切换到下一位客户。

真实经营宝灰度测试时，如果配置了 `MEITUAN_RPA_ALLOWED_CUSTOMERS`，插件只会自动切换白名单客户的未读会话。当前页面停在非白名单客户时，会清理旧会话映射并释放调度锁，避免卡住后不再切回测试客户。

美团经营宝当前未读判断使用左侧会话中的 <code>.mtd-badge-text.mtd-badge-position</code> 角标，例如数字 <code>1</code>。不要使用过宽的 <code>.mtd-badge</code> 容器，否则会把大量普通会话误判为未读。

美团经营宝回复输入框当前使用 <code>.dzim-chat-input-container[contenteditable="plaintext-only"]</code>，对应页面里的 <code>pre.dzim-chat-input-container</code>。回填时不能只改 <code>textContent</code>，还需要更新光标并触发 <code>beforeinput/input/change/selectionchange</code>，否则页面内部状态可能不知道输入框已有内容。

当前 Mock 会话只使用最新一条未读消息触发回复，防止客户连续拆句时生成多份回答。AI 会话锁最长等待 120 秒；全自动模式遇到中高风险草稿时不点击发送，也不占用页面输入框，草稿仍保留在服务端供人工处理。

扩展默认只监听并回填建议回复，不点击发送。“允许自动点击发送”会立即保存到 Chrome 扩展存储，并在 WebSocket 每次重连时同步到服务端；关闭浏览器或重启本地服务后状态仍会保留。`low` 风险草稿如果暂未满足自动点击条件，会先回填输入框供人工确认；美团白名单灰度会话在门店与客户会话一致、开关开启后新生成且通过 8 秒发送冷却时可以自动点击发送；`medium` 和 `high` 不占用输入框，继续保留在服务端供人工处理。真实页面 DOM 可能调整，消息、输入框和发送按钮选择器必须在当前账号页面现场确认，不能把其他美团业务线的选择器当作官方固定接口。

扩展面板中的“AI 自动识别”会向本地 API 发送脱敏 DOM 结构，再由 OpenClaw 生成候选选择器。快照不包含聊天正文、手机号、客户/门店 ID、图片地址或 Cookie；候选结果必须在当前页面通过方向、数量和会话校验后才会保存。

本地 API 暂停时扩展会显示未连接。API 恢复后，扩展使用 Chrome Alarm 最迟约 30 秒自动唤醒并重连；打开扩展面板会立即触发一次连接检查。自动发送开关和 DOM 配置保存在 Chrome 扩展存储中，不会因服务重启丢失。
