# TASKS.md - 项目开发任务清单

本文档用于给 Codex / 开发人员按阶段推进项目。

## 阶段 0：基础检查

- [ ] 确认所有文件均为 UTF-8，无 BOM。
- [ ] Windows 下运行前执行 `chcp 65001`。
- [ ] 复制 `.env.example` 为 `.env`。
- [ ] 启动 PostgreSQL 和 Redis。
- [ ] 执行 Prisma 迁移。
- [ ] 启动 API 服务。

## 阶段 1：后端基础项目

- [ ] 初始化 Fastify 服务。
- [ ] 加载环境变量并使用 zod 校验。
- [ ] 配置 Pino 日志。
- [ ] 配置 Prisma Client。
- [ ] 增加 `/health` 健康检查接口。
- [ ] 增加统一错误处理。

验收标准：

```bash
pnpm dev
curl http://localhost:3001/health
```

能返回：

```json
{"ok":true}
```

## 阶段 2：数据库模型

- [ ] 创建 shops 表。
- [ ] 创建 platform_accounts 表。
- [ ] 创建 conversations 表。
- [ ] 创建 messages 表。
- [ ] 创建 knowledge_sources 表。
- [ ] 创建 knowledge_chunks 表。
- [ ] 创建 reply_drafts 表。
- [ ] 启用 pgvector 扩展。

验收标准：

```bash
pnpm prisma:migrate
pnpm prisma:studio
```

能正常看到数据库表。

## 阶段 3：统一消息与会话服务

- [ ] 定义 `UnifiedMessage` 类型。
- [ ] 实现 `ConversationService.findOrCreateConversation`。
- [ ] 实现 `MessageService.saveInboundMessage`。
- [ ] 实现消息去重，避免重复处理平台回调。
- [ ] 实现最近会话历史查询。

验收标准：

调用 `/rpa/inbound` 后，数据库中能看到 conversation 和 message。

## 阶段 4：知识库与 RAG

- [ ] 实现 `KnowledgeService.createSource`。
- [ ] 实现中文文本切分 `chunkText`。
- [ ] 实现 `EmbeddingService.embedText`。
- [ ] 实现 chunk 入库。
- [ ] 实现 `RagService.search`，按 shopId 检索 topK。
- [ ] 增加 `/knowledge/sources` 和 `/knowledge/search`。

验收标准：

添加一段门店规则后，搜索“周末能用吗”能召回相关知识片段。

## 阶段 5：OpenClaw Client

- [ ] 实现 `OpenClawClient.generateReply`。
- [ ] endpoint 通过环境变量配置。
- [ ] 输入包含客户问题、会话历史、RAG 上下文、门店信息。
- [ ] 输出统一成 `{ content, confidence, raw }`。
- [ ] 如果 OpenClaw 调用失败，生成转人工草稿。

验收标准：

给定测试消息和知识库，能生成一条客服回复。

## 阶段 6：风控与人工审核

- [ ] 实现 `SafetyService.checkRisk`。
- [ ] 高风险关键词转人工。
- [ ] 未命中知识库转人工。
- [ ] 不允许承诺退款、赔偿、赠品、折扣。
- [ ] 实现 `reply_drafts` 草稿入库。
- [ ] 实现 `approve/reject` 接口。

验收标准：

包含“退款、投诉、赔偿”等词的问题不会自动发送，只生成草稿。

## 阶段 7：ReplyWorker

- [ ] 新消息进入队列。
- [ ] Worker 执行 RAG 检索。
- [ ] Worker 调 OpenClaw 生成回复。
- [ ] Worker 执行 SafetyService。
- [ ] 低风险时根据平台配置决定自动发送或生成草稿。
- [ ] 高风险时必须生成草稿。

验收标准：

调用 `/rpa/inbound` 后，能异步生成 reply_draft。

## 阶段 8：企业微信 Adapter

- [ ] 增加 `/webhooks/wecom/customer-service`。
- [ ] 增加企业微信回调验签占位。
- [ ] 增加 XML/JSON 解析占位。
- [ ] 转换为 UnifiedMessage。
- [ ] 实现发送客服消息占位。
- [ ] 后续接入真实企业微信客服 API。

验收标准：

模拟企业微信消息请求，能进入统一消息处理流程。

## 阶段 9：抖音 RPA Adapter

- [ ] 使用 Playwright persistent context 保持登录态。
- [ ] 编写 watcher 骨架。
- [ ] 优先监听 WebSocket / XHR。
- [ ] 其次读取 DOM 消息列表。
- [ ] 提取新消息后发送到 `/rpa/inbound`。
- [ ] 默认不自动发送，只生成建议回复。

验收标准：

本地手动调用 watcher 能输出模拟消息。

## 阶段 10：美团 RPA Adapter

- [ ] 使用 Playwright persistent context 保持登录态。
- [ ] 编写 watcher 骨架。
- [ ] 优先监听 WebSocket / XHR。
- [ ] 其次读取 DOM 消息列表。
- [ ] 提取新消息后发送到 `/rpa/inbound`。
- [ ] 默认不自动发送，只生成建议回复。

验收标准：

本地手动调用 watcher 能输出模拟消息。

## 阶段 11：管理后台，可后续实现

- [ ] 会话列表。
- [ ] 消息详情。
- [ ] AI 建议回复。
- [ ] 一键发送。
- [ ] 拒绝草稿。
- [ ] 知识库管理。
- [ ] 自动回复开关。
- [ ] 风控日志。

## 当前建议 MVP

第一版只需要完成：

- Fastify API
- Prisma 数据库
- UnifiedMessage
- RAG
- OpenClawClient
- ReplyWorker
- SafetyService
- ReplyDraft
- 企业微信 webhook 占位
- 抖音/美团 RPA 骨架

不要一开始就做复杂后台，也不要默认全自动发送。
