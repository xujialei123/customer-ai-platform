# Customer AI Platform Skeleton

多平台 AI 客服中台项目骨架，用于统一接入企业微信客服、抖音来客、美团到店团购，并通过独立 `rag-service` 提供知识库检索和 RAG 回复能力。

## 架构说明

首次接手、整体梳理或准备项目汇报时，请先阅读：[项目梳理指南](docs/project-walkthrough.md)。文档按启动、API、数据库、消息、订单、RAG、OpenClaw、RPA、企微和部署顺序标注了当前状态、风险与 TODO。

标准链路：

```text
平台 Webhook / RPA
  -> Platform Adapter / RPA Client
  -> UnifiedMessage / askRagService
  -> rag-service
  -> 知识库解析、切分、embedding、向量检索
  -> LLM / Agenes / Mock LLM
  -> Handoff 风控
  -> dryRun 建议回复或人工审核
```

当前保留旧 `apps/api` demo，不破坏原有 `/rpa/inbound`、ReplyWorker、企业微信 webhook；新增 `services/rag-service` 作为独立 RAG 服务。RPA watcher 会继续投递旧 API，同时调用统一 RPA client 获取 RAG 建议回复。

## 目录说明

```text
apps/api                         原有 Fastify API、Adapter、RPA watcher、ReplyWorker
services/rag-service             独立 RAG 服务
packages/shared                  平台、RAG 请求响应等共享类型
packages/rpa-sdk                 统一 RPA Client 和消息 hash 工具
config/channels.json             平台开关和知识库绑定示例
config/handoff-rules.json        转人工规则
config/prompts                   各平台 prompt 模板
scripts/init-db.sql              PostgreSQL + pgvector 初始化脚本
samples/kb                       本地测试知识库样例
```

## Windows 中文乱码注意

所有项目文件应使用 UTF-8 无 BOM。PowerShell 调试中文前建议执行：

```powershell
chcp 65001
$OutputEncoding = [System.Text.Encoding]::UTF8
```

Node.js 读写文本文件必须显式指定 `utf-8`。如果用 PowerShell 手写 JSON 请求发现服务端收到 `??`，请改用 Node/fetch、Postman，或先设置上面的 UTF-8 编码。

## 安装依赖

```bash
pnpm install
```

## 知识库上传页面

运行 `pnpm dev` 会同时启动 API、RAG 服务、RPA 模拟页面和 Chrome 扩展网关。默认还会打开系统 Chrome 的独立 Profile，登录态和插件配置保存在 `.sessions/extension-chrome`。正式版 Chrome 不保证接受命令行安装扩展，因此首次使用需在自动打开的 `chrome://extensions` 中加载一次项目扩展，后续启动会自动复用。知识库管理入口：

```text
http://127.0.0.1:8787/kb-admin
```

页面支持新建知识库、批量上传并解析、文件列表、检索测试和 RAG 回复测试。知识库、文件元数据和向量切片分别持久化到 Docker PostgreSQL 的 `rag_knowledge_bases`、`rag_knowledge_files`、`rag_knowledge_chunks` 表。Docker PostgreSQL 使用宿主机 `5433` 端口，避免与本机 PostgreSQL 的默认 `5432` 冲突。

## 经营宝真实 RPA

RPA 的当前能力边界、实现难点、已遇问题和生产上线条件见：[RPA 方案局限、难点与当前问题](docs/rpa-limitations-and-risks.md)。

推荐使用 `extensions/customer-ai-rpa` Chrome 扩展接入。扩展通过 `ws://127.0.0.1:3001/rpa/extension/ws` 连接本地 Adapter，不保存账号、密码或 Cookie。`pnpm dev` 启动的专用系统 Chrome 会复用固定 Profile；首次加载扩展的步骤见扩展目录 `README.md`。

默认配置：

```env
MEITUAN_RPA_MODE=extension
RPA_AUTO_SEND_ENABLED=false
```

以下 Playwright persistent context 仅作为兼容模式保留；只有显式设置 `MEITUAN_RPA_MODE=playwright` 时才会随 `pnpm dev` 启动。

设置 `MEITUAN_RPA_ENABLED=true` 后，`pnpm dev` 会启动独立的经营宝 watcher，并使用项目根目录 `.sessions/meituan-production` 保存专用 Chrome 登录态。首次启动需要在弹出的专用浏览器中人工登录；后续只要登录未被平台注销且目录未删除，就会自动复用。

经营宝聊天主体位于动态 `iframe[name="chat"]` 中，watcher 会等待该 iframe 真正出现后才开始采集。真实发送默认关闭：

```env
RPA_AUTO_SEND_ENABLED=false
```

在真实会话 ID、消息选择器和发送按钮都完成现场验证前，不要开启自动发送，也不要把 Cookie、账号或密码写入配置文件。

如果 Windows 上可选二进制依赖遇到权限问题，可先运行：

```powershell
$env:CI='true'
pnpm install --no-optional
```

## 配置环境

```bash
copy .env.example .env
```

默认本地优先跑通：

```env
VECTOR_STORE=memory
EMBEDDING_PROVIDER=mock
LLM_PROVIDER=mock
RPA_DRY_RUN=true
AUTO_REPLY_ENABLED=false
RPA_AUTO_SEND_ENABLED=false
```

`mock` 只用于开发验证，不能用于真实客服检索质量评估。生产或真实测试请配置 OpenAI-compatible embedding 和 LLM。

## 初始化数据库

Memory 模式不需要数据库。使用 pgvector 时：

```bash
psql "postgresql://postgres:123456@127.0.0.1:5432/ai_kb" -f scripts/init-db.sql
```

然后设置：

```env
VECTOR_STORE=pgvector
DATABASE_URL=postgresql://postgres:123456@127.0.0.1:5432/ai_kb
```

旧 `apps/api` Prisma 迁移仍可按原流程执行：

```bash
docker compose up -d
pnpm prisma:migrate
```

## 启动服务

启动独立 RAG 服务：

```bash
pnpm dev:rag
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

启动旧 API / RPA demo：

```bash
pnpm dev:api
```

构建检查：

```bash
pnpm build:rag
pnpm build
```

## 上传知识库并 Ingest

浏览器页面：

```text
http://127.0.0.1:8787/kb-admin
```

页面支持创建知识库、选择文件上传并解析、查看文件状态、删除文件、检索测试和 RAG 回复测试。默认 API Key 是 `.env` 中的 `RAG_API_KEY`，本地示例为 `local-dev-key`。

创建知识库：

```bash
curl -X POST http://127.0.0.1:8787/api/kb/create ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: local-dev-key" ^
  -d "{\"name\":\"抖音团购知识库\",\"description\":\"本地测试\"}"
```

上传文件：

```bash
curl -X POST http://127.0.0.1:8787/api/kb/<kbId>/upload ^
  -H "x-api-key: local-dev-key" ^
  -F "file=@samples/kb/douyin-after-sales.md"
```

解析并向量化：

```bash
curl -X POST http://127.0.0.1:8787/api/kb/<kbId>/files/<fileId>/ingest ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: local-dev-key" ^
  -d "{}"
```

查询文件状态：

```bash
curl -H "x-api-key: local-dev-key" http://127.0.0.1:8787/api/kb/<kbId>/files
```

## 测试 RAG Search / Chat

检索：

```bash
curl -X POST http://127.0.0.1:8787/api/rag/search ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: local-dev-key" ^
  -d "{\"platform\":\"douyin\",\"shopId\":\"douyin_shop_001\",\"kbIds\":[\"<kbId>\"],\"query\":\"这个套餐可以退款吗？\",\"topK\":5}"
```

对话：

```bash
curl -X POST http://127.0.0.1:8787/api/rag/chat ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: local-dev-key" ^
  -d "{\"platform\":\"douyin\",\"shopId\":\"douyin_shop_001\",\"sessionId\":\"douyin_user_001\",\"externalUserId\":\"douyin_user_001\",\"userMessage\":\"周末能用吗？\",\"history\":[]}"
```

敏感词测试：

```bash
curl -X POST http://127.0.0.1:8787/api/debug/test-chat ^
  -H "Content-Type: application/json" ^
  -d "{\"platform\":\"douyin\",\"shopId\":\"douyin_shop_001\",\"message\":\"我要投诉你们\"}"
```

## RPA 接入

抖音、美团 watcher 保留原 DOM 监听逻辑。收到新消息后会：

1. 生成 `createMessageHash(platform, shopId, sessionId, text)` 去重。
2. 投递旧 `/rpa/inbound`，不破坏原 demo。
3. 调用 `askRagService` 请求 `rag-service`。
4. `RPA_DRY_RUN=true` 时只打印建议回复，不真实发送。

抖音 mock：

```bash
pnpm --filter @customer-ai/api rpa:mock-site
pnpm --filter @customer-ai/api rpa:mock-watch
```

美团 mock：

```bash
$env:RPA_PLATFORM='meituan'
pnpm --filter @customer-ai/api rpa:mock-watch
```

真实平台接入时只替换 `config/rpa-selectors.example.json` 或环境变量中的 URL、消息选择器、输入框和发送按钮选择器。默认不要开启 `RPA_AUTO_SEND_ENABLED`。

## 企业微信接入

企业微信仍走 `apps/api/src/routes/webhooks.wecom.ts` 的官方 webhook 占位。后续可在企业微信 Adapter 或 ReplyWorker 中复用 `packages/rpa-sdk` 的 `askRagService`，让企微消息也统一进入 `rag-service`。当前 `rag-service` 已支持 `platform=wecom` 的 chat 请求和 prompt。

## 便携 OpenClaw

项目支持复用外部便携版 OpenClaw，不复制其程序、模型配置和密钥。开发启动器会先检查本地网关，未运行时再调用便携包启动脚本：

```env
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_PORTABLE_ROOT=F:\OpenClaw-USB-Portable
OPENCLAW_TOKEN_FILE=F:\OpenClaw-USB-Portable\data\.openclaw\gateway-token.txt
OPENCLAW_AUTO_START=true
OPENCLAW_MODEL=openclaw/default
OPENCLAW_CHAT_ENDPOINT=/v1/chat/completions
OPENCLAW_TIMEOUT_MS=30000
```

`OPENCLAW_TOKEN_FILE` 配置后，API 会显式按 UTF-8 读取便携包生成的 token，因此不需要在项目 `.env` 中重复保存 token。`pnpm dev` 会等待网关就绪后再启动 API、RAG 和 RPA。可使用以下地址检查连接状态：

```text
http://127.0.0.1:3001/health/openclaw
```

OpenClaw 只负责意图判断和生成回复；平台登录、消息采集、会话校验与发送仍由本项目 RPA Adapter 管理。

## 公司订单系统查询

旧 API 已增加订单系统 Adapter。默认使用 `mock`，可以先测试订单查询和 OpenClaw 上下文注入：

```powershell
$body = @{ orderNo = "TEST-ORDER-001" } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3001/orders/query -Method Post -ContentType "application/json; charset=utf-8" -Body $body
```

客户消息也可以直接发送：

```text
帮我查一下订单 TEST-ORDER-001
```

接真实公司接口时配置：

```env
ORDER_ADAPTER_MODE=legacy-admin
ADMIN_BASE_URL=https://your-real-admin.example.com
ADMIN_LOGIN_PATH=/api/auth/b/doLogin
ADMIN_ORDER_LIST_PATH=/api/biz/cxorderlaundry/page
ADMIN_TOKEN=
ADMIN_TENCODE=
ADMIN_ACCOUNT=
ADMIN_PASSWORD=
```

`legacy-admin` 模式迁移自已经跑通的 `wecom-openclaw-gateway`：使用 token + TenCode 查询，token 失效时会用只读客服账号进行 SM2 加密登录并重试。真实密钥只放 `.env`，不能提交。

也保留通用 `http` Adapter。该模式要求上游返回内部统一结构：

```json
{
  "found": true,
  "orderNo": "TEST-ORDER-001",
  "status": "已支付",
  "amount": 128,
  "itemName": "双人烤肉套餐",
  "usageStatus": "未核销",
  "customerNameMasked": "张**"
}
```

如果公司原始字段不同，应在专用 Adapter 中按接口文档映射，不能把原始客户隐私或鉴权信息直接传给 OpenClaw。

## 调试接口

```bash
curl http://127.0.0.1:8787/api/debug/config
curl http://127.0.0.1:8787/api/debug/routes
curl http://127.0.0.1:8787/api/debug/logs/retrieval
```

`/api/debug/config` 会隐藏 API KEY。

## Windows 一体化便携包

便携包包含生产构建、生产依赖、便携 Node、干净的 OpenClaw 程序及启停/诊断脚本。不会复制当前项目 `.env`、OpenClaw `data`、经营宝 Cookie、聊天记录或日志。

生成目录包：

```powershell
pnpm package:windows
```

默认输出：

```text
release\Customer-AI-Portable-YYYYMMDD-HHmmss
```

交付前保留完整目录结构。客服电脑需要安装 Google Chrome 和 Docker Desktop，然后双击：

```text
Start-Customer-AI.bat
```

首次使用需要客户在 OpenClaw 配置页填写自己的模型 API Key，并在经营宝专用 Chrome 中人工登录。停止服务使用 `Stop-Customer-AI.bat`，运行状态检查使用 `Doctor-Customer-AI.bat`。数据库卷、知识库文件和经营宝登录态会保留在客户电脑，不随停止操作删除。

## 常见问题

PDF 没解析出内容怎么办：
当前第一版先保证 txt、md、csv 跑通。PDF/DOCX/XLSX 会返回明确错误；扫描件 PDF 需要 OCR，后续可接 `pdf-parse`、`mammoth`、`xlsx`。

为什么检索不到：
确认文件已 ingest 且状态为 `completed`，`kbIds` 传对了。Memory 模式服务重启会清空内存数据。

为什么回复转人工：
命中敏感词、没有召回、最高分低于 `RAG_HARD_FLOOR`、连续 AI 回复过多、LLM 调用失败、知识库冲突都会转人工。`RAG_HARD_FLOOR` 到 `RAG_SCORE_THRESHOLD` 之间的候选会连同问题交给 OpenClaw 做证据判断；证据不足时模型必须返回固定转人工话术，后端会再次标记为转人工。

embedding key 没配怎么办：
默认 `EMBEDDING_PROVIDER=mock` 可以跑通流程，但真实召回质量必须配置 OpenAI-compatible embedding。

pgvector 没装怎么办：
先用 `VECTOR_STORE=memory` 跑通；安装 PostgreSQL 和 pgvector 后执行 `scripts/init-db.sql`，再切换 `VECTOR_STORE=pgvector`。

Windows 中文乱码怎么办：
确保文件是 UTF-8 无 BOM；PowerShell 先执行 `chcp 65001` 和 `$OutputEncoding = [System.Text.Encoding]::UTF8`；Node 读写文本始终显式指定 `utf-8`。
