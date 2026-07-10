<!-- 文件索引注释（不影响 Markdown 渲染）
  @file docs/project-walkthrough.md
  @module 后台、文档、样例
  @description 新人代码阅读顺序和模块导览。
  @see 联动关注：目录与入口变化时更新。
-->
# 多平台 AI 客服中台项目梳理指南

## 1. 文档用途

本文用于项目自查、汇报、交接和新人阅读。建议严格按本文顺序梳理，不要从某个平台 Adapter 或某个页面直接开始，否则容易混淆旧兼容代码与当前主链路。

状态标记说明：

- `[已完成]`：当前已有实现并经过本地验证。
- `[部分完成]`：核心链路可用，但仍有明确缺口。
- `[TODO]`：尚未实现或需要继续完善。
- `[风险]`：可能影响生产稳定性、安全性或合规性。
- `[兼容]`：为旧流程或本地测试保留，不应作为新功能首选入口。

## 2. 先建立总体认识

### 2.1 项目目标

项目用于统一接入企业微信客服、抖音来客和美团到店团购客服，并通过知识库 RAG、公司订单系统和 OpenClaw 生成建议回复。

标准业务链路：

```text
平台 Webhook / Chrome 扩展 RPA
  -> Platform Adapter
  -> UnifiedMessage
  -> 消息去重并入库
  -> 公司订单查询或 RAG 检索
  -> OpenClaw 生成回复
  -> 风控判断
  -> ReplyDraft / 自动发送
  -> 平台回填或发送
```

### 2.2 当前实际模块

| 模块 | 路径 | 作用 | 状态 |
| --- | --- | --- | --- |
| 主 API | `apps/api` | 平台入口、消息会话、队列、订单、草稿、扩展网关 | `[已完成]` |
| 独立 RAG 服务 | `services/rag-service` | 文件上传、解析、切片、Embedding、检索、OpenClaw 回复 | `[已完成]` |
| Chrome 扩展 | `extensions/customer-ai-rpa` | 经营宝 DOM 采集、WebSocket、回复回填和发送 | `[部分完成]` |
| 共享类型 | `packages/shared` | 平台和 RAG 公共类型 | `[已完成]` |
| RPA SDK | `packages/rpa-sdk` | RPA 请求 RAG、消息 hash | `[已完成]` |
| PostgreSQL | Docker `5433` | 业务表、知识库元数据和 pgvector | `[已完成]` |
| Redis | Docker `6379` | BullMQ 消息队列 | `[已完成]` |
| 便携 OpenClaw | 外部目录 | 意图判断和回复生成 | `[部分完成]` |

> `[重点备注]`：`apps/api/src/services/rag.service.ts` 和 `apps/api/src/services/knowledge.service.ts` 属于旧 API 内的兼容 RAG 示例；新知识库页面和当前上传解析主链路位于 `services/rag-service`。新增 RAG 功能应优先修改独立 RAG 服务，避免形成第三套实现。

## 3. 推荐梳理顺序

## 第 0 步：先读规则和任务边界

按顺序阅读：

1. `agents.md`
2. `tasks.md`
3. `README.md`
4. `docs/rpa-limitations-and-risks.md`

重点确认：

- 所有文件必须为 UTF-8 无 BOM。
- 核心业务代码必须有中文注释。
- 自动发送默认关闭。
- 风险问题必须转人工。
- 未确认的平台接口只能保留 Adapter 和 TODO，不能编造。

## 第 1 步：理解启动入口和基础设施

阅读文件：

- 根目录 `package.json`
- `apps/api/src/dev/run-all.ts`
- `docker-compose.yml`
- `.env.example`

`pnpm dev` 当前会负责：

1. 检查并启动 Docker Desktop。
2. 启动 PostgreSQL 和 Redis。
3. 检查或启动便携 OpenClaw。
4. 启动主 API `3001`。
5. 启动 RAG 服务和知识库页面 `8787`。
6. 启动 RPA Mock 页面 `3100`。
7. 启动抖音 Mock watcher。
8. 默认使用 Chrome 扩展模式接入美团。

验证顺序：

```powershell
docker compose ps
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/health/openclaw
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod http://127.0.0.1:3001/rpa/extension/status
```

备注：

- `[已完成]` PostgreSQL 使用宿主机端口 `5433`，避免与本机 `5432` 冲突。
- `[已完成]` Redis 使用 `6379`。
- `[风险]` `pnpm dev` 启动多个子进程，旧进程残留会占用 `3001/3100/8787`。
- `[风险]` 修改 `.env` 后应确认子进程已重新读取；RAG 服务已显式以根目录 `.env` 为准。

## 第 2 步：理解主 API 入口

阅读顺序：

1. `apps/api/src/main.ts`
2. `apps/api/src/config/env.ts`
3. `apps/api/src/lib/prisma.ts`
4. `apps/api/src/lib/queue.ts`
5. `apps/api/src/routes/*`

主要路由：

| 路由 | 作用 |
| --- | --- |
| `GET /health` | API 健康检查 |
| `GET /health/openclaw` | OpenClaw 配置与连接检查 |
| `POST /rpa/inbound` | RPA 客户消息入口 |
| `POST /rpa/outbound` | 平台已发送商家消息入库 |
| `GET /rpa/extension/status` | Chrome 扩展连接和会话状态 |
| `POST /rpa/extension/analyze-dom` | OpenClaw 分析脱敏 DOM 候选选择器 |
| `GET /reply-drafts/recent` | 查询客户会话草稿 |
| `POST /orders/query` | 按订单号查询 |
| `POST /orders/chat-query` | 从自然语言识别并查询订单 |
| 企业微信 Webhook | 官方回调验签、接收和回复 |

备注：

- `[已完成]` Fastify 统一错误处理。
- `[风险]` CORS 当前为 `origin: true`，生产部署需要限制允许来源。
- `[风险]` 调试接口不应直接暴露公网。
- `[TODO]` 管理 API 尚未形成完整鉴权和角色权限体系。

## 第 3 步：理解数据库模型

阅读顺序：

1. `apps/api/prisma/schema.prisma`
2. `apps/api/prisma/migrations/000001_init/migration.sql`
3. `apps/api/prisma/migrations/000002_conversation_context/migration.sql`
4. `scripts/init-db.sql`

核心业务表：

- `shops`
- `platform_accounts`
- `conversations`
- `messages`
- `reply_drafts`
- `knowledge_sources`
- `knowledge_chunks`

独立 RAG 持久化表：

- `rag_knowledge_bases`
- `rag_knowledge_files`
- `rag_knowledge_chunks`

会话唯一维度：

```text
platform + shopId + platformConversationId
```

备注：

- `[已完成]` 客户消息和商家实际发送消息双向入库。
- `[已完成]` 最近 12 条消息进入 OpenClaw，较早消息生成持久化摘要。
- `[风险]` 旧 API 知识表和独立 RAG 表并存，后续应确定保留策略。
- `[TODO]` 需要增加数据保留周期、隐私删除和审计策略。

数据库查看：

```powershell
pnpm prisma:studio
```

## 第 4 步：理解统一消息和 Adapter

阅读顺序：

1. `packages/shared/src/index.ts`
2. `apps/api/src/adapters/types.ts`
3. `apps/api/src/adapters/index.ts`
4. 各平台 Adapter
5. `apps/api/src/services/conversation.service.ts`
6. `apps/api/src/services/message.service.ts`

平台 Adapter：

- `wecom.adapter.ts`
- `douyin-rpa.adapter.ts`
- `meituan-rpa.adapter.ts`

备注：

- `[已完成]` 平台消息统一转为同一种业务结构。
- `[已完成]` 平台原始消息 ID 用于数据库去重。
- `[风险]` 消息 ID 当前是全局主键；接入更多平台前应确认不同平台 ID 不会碰撞，必要时改为平台复合键。
- `[TODO]` 附件、图片、语音等非文本消息尚未形成完整处理流程。

## 第 5 步：理解异步回复 Worker

阅读顺序：

1. `apps/api/src/routes/rpa.ts`
2. `apps/api/src/workers/reply.worker.ts`
3. `apps/api/src/services/safety.service.ts`
4. `apps/api/src/services/send.service.ts`
5. `apps/api/src/routes/reply-drafts.ts`

处理过程：

```text
/rpa/inbound
  -> MessageService 去重入库
  -> BullMQ inbound-message
  -> ReplyWorker
  -> 订单识别 / RAG
  -> OpenClaw
  -> SafetyService
  -> ReplyDraft 或 SendService
```

备注：

- `[已完成]` 当前 Worker 默认串行消费，避免本地并发生成多个草稿。
- `[已完成]` 当前问题会从历史上下文中排除，避免重复传给模型。
- `[已完成]` 平台真正出现商家右侧消息后才记录 outbound。
- `[风险]` 多实例部署时需要分布式会话锁，不能只依赖单 Worker 串行。
- `[TODO]` 需要失败重试上限、死信队列和人工可见的失败状态。

## 第 6 步：理解订单查询

阅读顺序：

1. `apps/api/src/routes/orders.ts`
2. `apps/api/src/services/order.service.ts`
3. `apps/api/src/services/openclaw.service.ts` 中订单动作判断

当前模式：

- `mock`：仅开发占位。
- `http`：通用内部订单 Adapter。
- `legacy-admin`：复用已跑通的旧后台登录和查询协议。

备注：

- `[已完成]` 支持按订单号和手机号查询。
- `[已完成]` 查询结果脱敏后再交给 OpenClaw 整理。
- `[风险]` 真实账号和密码只能放 `.env`，不能进入代码或日志。
- `[风险]` 订单状态必须实时查询，不能使用会话摘要中的旧状态回答。
- `[TODO]` 需要上游正式接口文档和稳定 SLA；不能把当前旧后台协议描述成官方接口。

## 第 7 步：理解独立 RAG 服务

阅读顺序：

1. `services/rag-service/src/main.ts`
2. `services/rag-service/src/routes/api.ts`
3. `services/rag-service/src/services/rag-application.ts`
4. `services/rag-service/src/parsers/file-parser.ts`
5. `services/rag-service/src/services/splitter.ts`
6. `services/rag-service/src/providers/embedding.ts`
7. `services/rag-service/src/vector-store/pg-vector-store.ts`
8. `services/rag-service/src/services/prompt-renderer.ts`
9. `services/rag-service/src/providers/llm.ts`
10. `services/rag-service/src/services/handoff.ts`

上传链路：

```text
文件上传
  -> 文件解析
  -> Markdown 标题/段落切片
  -> 千问 text-embedding-v4 生成 1536 维向量
  -> PostgreSQL pgvector
```

检索与回答链路：

```text
客户问题
  -> 纯寒暄白名单直接固定回复
  -> 其他问题生成 Query Embedding
  -> pgvector TopK
  -> 风险和硬拒绝线判断
  -> 问题 + TopK 片段传给 OpenClaw
  -> 后端识别转人工话术
```

当前阈值：

```text
无召回或 score < 0.35：直接转人工
0.35 <= score < 0.65：OpenClaw 低置信证据审查
score >= 0.65：正常交给 OpenClaw 整理
```

备注：

- `[已完成]` 千问 `text-embedding-v4` 真实接口，显式使用 1536 维。
- `[已完成]` 重新 ingest 会删除旧切片，避免新旧 chunk 混合。
- `[已完成]` 纯问候、感谢、告别不调用 Embedding 和模型。
- `[风险]` 当前 pgvector 是纯向量检索，尚无 BM25/关键词混合检索。
- `[风险]` `RAG_USE_RERANK=false`，没有正式 Rerank 模型。
- `[风险]` 当前知识库路由配置中的示例 ID 与实际上传 ID 不一致时，会退回搜索全部知识库，可能造成知识污染。
- `[TODO]` 为每个平台、门店配置真实知识库绑定，取消生产环境“全部知识库兜底”。
- `[TODO]` 增加标准问答评测集，按真实数据校准 `0.35/0.65`，不能长期凭感觉调阈值。
- `[TODO]` 删除或隔离只有问题没有答案的测试章节，避免参与生产召回。

RAG 验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/debug/config
Invoke-RestMethod http://127.0.0.1:8787/api/debug/routes
Invoke-RestMethod http://127.0.0.1:8787/api/debug/logs/retrieval
```

## 第 8 步：理解 OpenClaw

阅读位置：

- `apps/api/src/services/openclaw.service.ts`
- `services/rag-service/src/providers/llm.ts`
- `config/prompts/*.txt`
- `.env` 中 `OPENCLAW_*`

职责边界：

- OpenClaw 负责意图判断和组织客服话术。
- OpenClaw 不直接登录平台。
- OpenClaw 不直接操作浏览器。
- OpenClaw 不直接调用未经白名单校验的公司接口。
- 平台消息、会话 ID、风控和发送由本项目负责。

备注：

- `[已完成]` 问题、历史和检索片段会一起传给 OpenClaw。
- `[已完成]` 证据不足时要求返回固定转人工话术。
- `[已完成]` RAG OpenClaw 调用改为单次，避免最坏 90 秒重试。
- `[风险]` 当前曾出现 OpenClaw 超时和无效 JSON，模型不可用时必须安全转人工。
- `[TODO]` 增加模型延迟、错误率和超时监控。

## 第 9 步：理解 Chrome 扩展 RPA

阅读顺序：

1. `extensions/customer-ai-rpa/manifest.json`
2. `extensions/customer-ai-rpa/background.js`
3. `extensions/customer-ai-rpa/content.js`
4. `extensions/customer-ai-rpa/popup.js`
5. `apps/api/src/rpa/extension-gateway.ts`
6. `docs/rpa-limitations-and-risks.md`

当前经营宝链路：

```text
普通 Chrome 人工登录
  -> 扩展扫描普通 DOM 和封闭 Shadow DOM
  -> 提取真实 shopId/userId/messageId
  -> WebSocket /rpa/extension/ws
  -> 主 API
  -> 草稿返回扩展
  -> 校验当前门店和客户
  -> 回填输入框或点击发送
```

自动发送条件：

- 扩展开关明确开启并持久化。
- 草稿为开关开启后新生成。
- `riskLevel` 必须为 `low`。
- 门店和客户 ID 必须一致。
- 通过 8 秒发送冷却。
- 每轮最多处理一条草稿。

备注：

- `[已完成]` 扩展开关状态保存在 Chrome 存储，服务重启后保持。
- `[已完成]` Chrome Alarm 最迟约 30 秒自动重连。
- `[已完成]` 扩展上下文失效后停止旧定时器，避免控制台持续报错。
- `[已完成]` 客户和商家消息双向入库。
- `[已完成]` AI DOM 候选只在真实页面验证通过后保存。
- `[部分完成]` 当前稳定处理正在打开的客户会话。
- `[TODO]` 左侧多客户未读队列、自动切换和恢复原会话尚未完成。
- `[风险]` RPA 与人工共用标签页会争抢页面焦点，建议使用专用窗口。
- `[风险]` 平台 DOM 改版会导致选择器失效。
- `[风险]` RPA 不是官方 API，不能绕过验证码、平台风控或权限。

## 第 10 步：理解企业微信

阅读顺序：

1. `apps/api/src/routes/webhooks.wecom.ts`
2. `apps/api/src/adapters/wecom.adapter.ts`
3. `apps/api/src/services/wecom-crypto.service.ts`
4. `apps/api/src/services/wecom-client.service.ts`

备注：

- `[已完成]` 已从本地参考项目接入真实回调和消息处理逻辑。
- `[已完成]` 默认仍受自动回复开关和风控约束。
- `[风险]` 企业微信 token、AES Key 和 Secret 只能放 `.env`。
- `[TODO]` 生产域名、Cloudflare Tunnel 和企业微信后台配置需要形成部署清单。

## 第 11 步：理解知识库管理页面

阅读位置：

- `services/rag-service/public/kb-admin.html`
- `services/rag-service/src/routes/admin-page.ts`
- `services/rag-service/src/routes/api.ts`

页面地址：

```text
http://127.0.0.1:8787/kb-admin
```

备注：

- `[已完成]` 知识库创建、批量上传并解析、文件状态、删除、检索和 RAG 测试。
- `[已完成]` 上传并解析会调用真实千问 Embedding API。
- `[风险]` 当前 API Key 是本地开发级保护，不是完整后台登录系统。
- `[TODO]` 增加知识库与门店/平台的可视化绑定管理。
- `[TODO]` 增加重新 ingest 按钮、Embedding 模型版本和向量维度展示。

## 第 12 步：理解 Mock 和兼容 RPA

阅读位置：

- `apps/api/src/rpa/mock-chat-server.ts`
- `apps/api/src/rpa/mock-site.watcher.ts`
- `apps/api/src/rpa/dom-message-watcher.ts`
- `apps/api/src/rpa/meituan.watcher.ts`
- `apps/api/src/rpa/douyin.watcher.ts`

备注：

- `[兼容]` Mock 页面用于没有真实账号时验证链路。
- `[兼容]` Playwright 美团 watcher 保留但默认不启动，原因是登录时曾疑似触发平台风控。
- `[风险]` 不要让 Mock 数据混入真实订单或真实客服验收结论。

## 第 13 步：理解 Windows 便携包

阅读顺序：

1. `scripts/build-windows-portable.ps1`
2. `packaging/windows-portable/Start-Customer-AI.ps1`
3. `packaging/windows-portable/Stop-Customer-AI.ps1`
4. `packaging/windows-portable/Doctor-Customer-AI.ps1`

备注：

- `[已完成]` 支持 Windows 一体化便携包。
- `[已完成]` 可复用外部便携 OpenClaw。
- `[风险]` 打包脚本不得递归跟随 pnpm Junction 删除源目录。
- `[TODO]` 每次正式发布前必须在全新目录进行启动、停止、重启和数据保留验收。

## 4. 当前完成度总表

| 能力 | 状态 | 备注 |
| --- | --- | --- |
| API、PostgreSQL、Redis 启动 | `[已完成]` | Docker 本地可运行 |
| Prisma 迁移 | `[已完成]` | 已增加会话上下文迁移 |
| 千问 Embedding + pgvector | `[已完成]` | `text-embedding-v4`，1536 维 |
| 文件上传、解析和切片 | `[已完成]` | Markdown 按标题切片 |
| RAG + OpenClaw | `[部分完成]` | 逻辑可用，OpenClaw 偶发超时 |
| 订单真实查询 | `[已完成]` | 使用已跑通旧后台 Adapter |
| 企业微信真实接入 | `[已完成]` | 仍需生产部署清单 |
| 美团当前会话采集 | `[已完成]` | Chrome 扩展 + Shadow DOM |
| 美团多客户调度 | `[TODO]` | 最大功能缺口 |
| 自动发送 | `[部分完成]` | 仅 low 风险，需继续灰度 |
| 抖音真实页面接入 | `[TODO]` | 当前主要是 Mock/骨架 |
| 管理后台 | `[部分完成]` | 知识库页面已有，完整运营后台未完成 |
| Windows 便携部署 | `[已完成]` | 仍需每版回归 |

## 5. 优先级建议

### P0：上线前必须完成

1. 为真实门店配置准确的知识库绑定，禁止搜索全部知识库兜底。
2. 建立 RAG 标准评测集，校准阈值并验证转人工规则。
3. 完成美团左侧未读会话队列和会话切换保护。
4. 增加自动发送审计、失败状态和紧急总开关。
5. 增加 OpenClaw、Embedding、订单系统和 WebSocket 监控。
6. 限制 CORS、调试接口和管理页面访问范围。

### P1：稳定性完善

1. 增加混合检索和 Rerank。
2. 增加 BullMQ 死信队列和多实例会话锁。
3. 增加附件、图片和非文本消息处理。
4. 增加知识库版本、回滚和重新 ingest 管理。
5. 整理旧 API RAG 与独立 RAG 服务的去留。

### P2：产品化

1. 完整会话和草稿审核后台。
2. 门店、平台账号、知识库和自动回复策略管理。
3. 风控日志、发送审计、质量报表和人工接管。
4. 正式安装包升级、备份和恢复方案。

## 6. 每次改动后的验证顺序

```powershell
# 1. 类型检查
pnpm build:all

# 2. 基础服务
docker compose ps
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:8787/health

# 3. OpenClaw
Invoke-RestMethod http://127.0.0.1:3001/health/openclaw

# 4. RAG 配置和日志
Invoke-RestMethod http://127.0.0.1:8787/api/debug/config
Invoke-RestMethod http://127.0.0.1:8787/api/debug/logs/retrieval

# 5. Chrome 扩展
Invoke-RestMethod http://127.0.0.1:3001/rpa/extension/status
```

验收时至少覆盖：

- 纯问候。
- 知识库明确答案。
- 中间分数证据审查。
- 完全无关问题。
- 退款、投诉等风险问题。
- 真实订单查询。
- 多客户会话隔离。
- 服务停止后扩展重连。
- 自动发送开关关闭和开启。
- 重复消息与历史草稿不重复发送。

## 7. 当前最重要的结论

项目已经不是单纯骨架，核心链路可以演示和进行人工辅助客服测试；但还不是无人值守的生产系统。当前最重要的三个缺口是：真实知识库精确绑定、美团多客户调度、生产级监控与权限。后续开发应围绕这三项推进，不宜继续横向增加新的临时入口。
