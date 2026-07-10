/**
 * 一次性脚本：根据 docs/project-files.js 索引，为项目核心文件添加中文文件头注释。
 * 用法：node scripts/add-file-comments.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Map<string, { module: string, description: string, related: string }>} */
const fileMeta = new Map();

function register(group, path, description, related) {
  fileMeta.set(path.replace(/\\/g, '/'), { module: group, description, related });
}

// 从 docs/project-files.js 同步的索引（路径 / 职责 / 联动）
const groups = [
  ['根目录与配置', [
    ['AGENTS.md', 'AI/Codex 开发约束、编码、注释、架构、安全和流程文档同步规则。', '所有任务开始前读取，禁止删除编码和风控限制。'],
    ['tasks.md', '项目分阶段任务和实施顺序。', '每阶段完成后运行类型检查或最小测试。'],
    ['README.md', '项目入口、启动、接口地址和交付说明。', '端口、启动与交付变化时同步。'],
    ['package.json', '工作区统一启动、构建、迁移和便携包命令。', '各子包 scripts。'],
    ['pnpm-workspace.yaml', '声明 apps、services、packages 工作区和 pnpm allowBuilds。', '新增包或生产依赖构建脚本时更新。'],
    ['docker-compose.yml', '启动 PostgreSQL/pgvector 与 Redis。', '数据库、Redis 环境变量和端口文档。'],
    ['.env.example', '环境变量示例模板，复制为 .env 后填写。', 'env.ts 与各 Service 读取项。'],
    ['.gitignore', 'Git 忽略规则：node_modules、dist、会话目录等。', '新增生成物目录时同步。'],
    ['config/channels.json', '各平台渠道开关、默认 shopId、知识库绑定和 dryRun 策略。', '平台 Adapter 与 RAG 知识路由。'],
    ['config/handoff-rules.json', '转人工关键词、置信度阈值和禁止承诺规则。', 'SafetyService、RAG handoff 和测试。'],
    ['config/kb-routes.json', '平台/门店到知识库 ID 的路由映射。', 'RAG resolveKbIds。'],
    ['config/rag.json', '旧 RAG 参数兼容配置（阈值、TopK 等）。', 'Hybrid 配置和环境变量。'],
    ['config/rpa-selectors.example.json', 'RPA DOM 选择器示例，复制为 local 后现场验证。', 'Chrome 插件默认值和 selector-config.ts。'],
    ['config/prompts/default.txt', '默认客服 Prompt 模板。', 'PromptRenderer。'],
    ['config/prompts/douyin.txt', '抖音平台补充 Prompt。', '抖音话术策略。'],
    ['config/prompts/meituan.txt', '美团平台补充 Prompt。', '美团话术策略。'],
    ['config/prompts/wecom.txt', '企微平台补充 Prompt。', '企微话术策略。'],
  ]],
  ['API 入口与基础设施', [
    ['apps/api/package.json', 'API 服务依赖及 dev、build、Prisma、RPA Mock 命令。', '根 package.json 和 pnpm-lock.yaml。'],
    ['apps/api/tsconfig.json', 'API TypeScript 编译配置。', '新增源码目录时更新 include。'],
    ['apps/api/src/main.ts', '创建 Fastify 实例，注册路由、ReplyWorker 和 RPA WebSocket 网关。', 'routes/*、workers/reply.worker.ts、extension-gateway.ts。'],
    ['apps/api/src/config/env.ts', 'UTF-8 读取根 .env 并校验 API 所需环境变量。', '.env.example 和各 Service。'],
    ['apps/api/src/dev/run-all.ts', '开发编排：Docker、OpenClaw、API、RAG、Mock 站点和专用 Chrome。', '端口、进程清理、README 启动说明。'],
    ['apps/api/src/lib/prisma.ts', '创建并导出 Prisma Client 单例。', 'schema.prisma 和 DATABASE_URL。'],
    ['apps/api/src/lib/queue.ts', '创建 Redis/BullMQ 连接与 inbound 消息队列。', 'ReplyWorker 和队列排障。'],
    ['apps/api/prisma/schema.prisma', '业务数据模型：门店、会话、消息、草稿和旧知识片段。', '迁移文件与各 Service 查询。'],
    ['apps/api/prisma/migrations/000001_init/migration.sql', '初始化业务表和 pgvector 扩展。', '已执行迁移不要重写。'],
    ['apps/api/prisma/migrations/000002_conversation_context/migration.sql', '为会话表增加摘要上下文字段。', 'MessageService 上下文维护。'],
  ]],
  ['API Adapter 与路由', [
    ['apps/api/src/adapters/types.ts', '平台 Adapter 输入输出类型定义。', 'UnifiedMessage（packages/shared）。'],
    ['apps/api/src/adapters/index.ts', '按 platform 字段选择对应 Adapter。', '新增平台时在此注册。'],
    ['apps/api/src/adapters/douyin-rpa.adapter.ts', '抖音 RPA 原始 payload 转 UnifiedMessage。', 'RPA inbound 和 ReplyWorker。'],
    ['apps/api/src/adapters/meituan-rpa.adapter.ts', '美团 RPA/插件消息转 UnifiedMessage。', '插件 shopId/conversationId 映射。'],
    ['apps/api/src/adapters/wecom.adapter.ts', '解析企微客服和应用消息为 UnifiedMessage。', 'Webhook、加解密和发送出口。'],
    ['apps/api/src/routes/health.ts', 'API 健康检查与 OpenClaw 连接状态。', 'run-all 与 Doctor 脚本。'],
    ['apps/api/src/routes/conversations.ts', '查询会话列表和消息历史。', 'ConversationService。'],
    ['apps/api/src/routes/knowledge.ts', '旧知识库接口兼容层。', '新知识优先走 8787 rag-service。'],
    ['apps/api/src/routes/orders.ts', '订单查询 HTTP 测试接口。', 'OrderService 和订单 Adapter。'],
    ['apps/api/src/routes/reply-drafts.ts', '回复草稿查询、批准、拒绝和 sent 标记。', 'Extension Gateway 与人工审核。'],
    ['apps/api/src/routes/rpa.ts', 'RPA inbound/outbound、选择器配置和扩展状态。', 'MessageService、Chrome 插件。'],
    ['apps/api/src/routes/webhooks.wecom.ts', '企微 URL 校验和消息回调入口。', 'Crypto、Adapter、WecomClient。'],
  ]],
  ['API Service 与 Worker', [
    ['apps/api/src/services/conversation.service.ts', '按平台、门店、客户创建隔离会话。', 'Prisma 唯一键和 MessageService。'],
    ['apps/api/src/services/message.service.ts', '消息去重、入库、摘要更新、outbound 确认和草稿关闭。', 'RPA outbound、ReplyDraft。'],
    ['apps/api/src/services/embedding.service.ts', 'API 旧知识表 Embedding 兼容实现。', '新检索由 8787 rag-service 负责。'],
    ['apps/api/src/services/knowledge.service.ts', '旧知识片段写入和向量搜索。', '避免与 rag-service 再次分叉。'],
    ['apps/api/src/services/rag.service.ts', '调用 8787 Hybrid RAG 并兼容旧 Chunk 格式。', 'ReplyWorker、RAG_API_KEY。'],
    ['apps/api/src/services/openclaw.service.ts', 'OpenClaw 回复生成、订单意图识别和纯文本清理。', 'ReplyWorker 与 Token 文件。'],
    ['apps/api/src/services/order.service.ts', '订单号识别、多轮等待判断、公司系统查询和脱敏。', '订单 Adapter 和 ReplyWorker 路由。'],
    ['apps/api/src/services/order-routing.test.ts', '回归测试：多轮纯订单号路由和普通编号防误判。', 'OrderService 与 ReplyWorker 路由顺序。'],
    ['apps/api/src/services/safety.service.ts', '高风险词、禁止承诺和自动发送开关判定。', 'AGENTS.md 风控规则。'],
    ['apps/api/src/services/send.service.ts', '选择平台发送出口并检查全局 AUTO_REPLY 开关。', '企微 Client、RPA 自动发送开关。'],
    ['apps/api/src/services/wecom-client.service.ts', '企微 access_token 获取和官方发送 API 请求。', '企微环境变量。'],
    ['apps/api/src/services/wecom-crypto.service.ts', '企微回调签名验证和 AES 消息加解密。', 'WECOM_TOKEN/AES_KEY。'],
    ['apps/api/src/utils/chunk-text.ts', '旧知识文本按段落/长度切片。', '不要用于替代 GBrain 知识卡片。'],
    ['apps/api/src/workers/reply.worker.ts', '消费 inbound 队列：先订单路由，再 RAG，再 OpenClaw、风控和草稿生成。', '回复主链路排障入口。'],
  ]],
  ['RPA 与 Chrome 插件', [
    ['apps/api/src/rpa/extension-gateway.ts', '本地 WebSocket 网关：会话注册、messageId 草稿关联和状态推送。', 'background.js 通信协议。'],
    ['apps/api/src/rpa/mock-chat-server.ts', '3100 端口多会话 Mock 聊天页，支持随机消息和页面发送。', 'content.js 选择器调试。'],
    ['apps/api/src/rpa/selector-config.ts', '读写平台 RPA DOM 选择器配置。', 'RPA 配置路由和插件默认值。'],
    ['apps/api/src/rpa/browser.ts', 'Playwright persistent context 浏览器启动器（兼容模式）。', '非默认插件模式时使用。'],
    ['apps/api/src/rpa/dom-message-watcher.ts', '旧 Playwright DOM 消息监听和自动发送。', '不能与默认 Chrome 插件重复运行。'],
    ['apps/api/src/rpa/mock-site.watcher.ts', '旧 Mock 站点 Playwright Watcher。', '仅 playwright 模式调试。'],
    ['apps/api/src/rpa/douyin.watcher.ts', '抖音 Playwright Adapter 骨架。', '真实接口未确认，保留 TODO。'],
    ['apps/api/src/rpa/meituan.watcher.ts', '美团 Playwright Adapter 骨架。', '默认推荐使用 Chrome 插件。'],
    ['apps/api/src/rpa/meituan-real.watcher.ts', '美团真实页 Playwright 兼容入口。', '真实账号灰度验证。'],
    ['extensions/customer-ai-rpa/manifest.json', 'Chrome MV3 扩展权限、匹配域名和脚本声明。', '版本号与 host_permissions。'],
    ['extensions/customer-ai-rpa/background.js', 'WebSocket 连接、设置迁移、多会话路由和断线重连。', 'extension-gateway.ts 协议。'],
    ['extensions/customer-ai-rpa/content.js', 'DOM/Shadow DOM 消息采集、未读队列、会话切换、回填和发送。', '平台 DOM 变化与串话防护。'],
    ['extensions/customer-ai-rpa/popup.html', '扩展弹窗设置面板 HTML 结构。', 'popup.js 字段绑定。'],
    ['extensions/customer-ai-rpa/popup.js', '扩展配置持久化、连接状态和 AI 选择器识别。', 'Chrome storage API。'],
    ['extensions/customer-ai-rpa/popup.css', '扩展弹窗 UI 样式。', '窄屏布局与溢出处理。'],
    ['extensions/customer-ai-rpa/README.md', '扩展安装、测试步骤和安全注意事项。', '插件行为变化时同步更新。'],
  ]],
  ['RAG Service 兼容层', [
    ['services/rag-service/package.json', '8787 RAG 服务依赖、构建和测试命令。', 'pnpm-lock.yaml 和根 build:rag。'],
    ['services/rag-service/tsconfig.json', 'RAG 服务 TypeScript 严格编译配置。', '所有新增 src 源码。'],
    ['services/rag-service/src/main.ts', '启动 8787 端口 Fastify RAG 服务。', 'routes/api.ts 和 admin-page.ts。'],
    ['services/rag-service/src/config/env.ts', 'Embedding、LLM、阈值、上传目录等环境变量。', '.env.example 和 Providers。'],
    ['services/rag-service/src/routes/admin-page.ts', '提供 /kb-admin 知识库管理页面路由。', 'public/kb-admin.html。'],
    ['services/rag-service/src/routes/api.ts', 'KB CRUD、Wiki 编译、卡片、Graph、Gap、检索和回答 API。', 'Brain 模块与 Hybrid RAG。'],
    ['services/rag-service/src/parsers/file-parser.ts', 'TXT/MD/CSV/PDF/DOCX/XLSX 文件解析。', '扫描 PDF 仍需 OCR Adapter。'],
    ['services/rag-service/src/providers/embedding.ts', 'Embedding Provider（mock/OpenAI 兼容）。', '向量维度与 pgvector。'],
    ['services/rag-service/src/providers/llm.ts', 'LLM Provider（mock/OpenAI/Agenes/OpenClaw）。', 'Wiki 编译、Rerank、Answer 生成。'],
    ['services/rag-service/src/services/rag-application.ts', '旧 Chunk ingest/chat 兼容链路。', '新链路优先 Hybrid 知识卡片。'],
    ['services/rag-service/src/services/store.ts', '旧 KB/File 内存缓存和 PostgreSQL 持久化恢复。', 'init-db.sql 和 uploads 目录。'],
    ['services/rag-service/src/services/splitter.ts', '旧 Chunk 机械切分逻辑。', '卡片生成不能退化为机械切片。'],
    ['services/rag-service/src/services/handoff.ts', '旧 RAG 转人工规则加载与判定。', 'config/handoff-rules.json。'],
    ['services/rag-service/src/services/prompt-renderer.ts', '旧 RAG Prompt 模板组合渲染。', 'config/prompts/*.txt。'],
    ['services/rag-service/src/vector-store/vector-store.ts', '向量存储抽象接口定义。', 'memory 与 pgvector 实现。'],
    ['services/rag-service/src/vector-store/index.ts', '按 VECTOR_STORE 环境变量选择存储实现。', 'env.ts 配置项。'],
    ['services/rag-service/src/vector-store/memory-vector-store.ts', '内存向量检索（开发/测试用，重启清空）。', '仅本地流程验证。'],
    ['services/rag-service/src/vector-store/pg-vector-store.ts', 'Chunk 级 pgvector 写入和相似度检索。', '向量维度与 HNSW 索引。'],
    ['services/rag-service/src/types.ts', '旧 RAG 公共类型占位与导出。', '新类型见 brain/types 和 rag/types。'],
  ]],
  ['GBrain 与 Hybrid RAG', [
    ['services/rag-service/src/brain/types.ts', 'Wiki、KnowledgeCard、Graph、Gap 等 Brain 类型。', '数据库表结构和 API Schema。'],
    ['services/rag-service/src/brain/config.ts', '文档长度、卡片数量等 Brain 编译配置。', '编译成本与 LLM 调用次数。'],
    ['services/rag-service/src/brain/document-parser.ts', '将原始文件解析为统一 ParsedDocument 结构。', 'parsers/file-parser.ts。'],
    ['services/rag-service/src/brain/wiki-compiler.ts', 'LLM 生成结构化 Wiki，失败时本地规则回退。', 'wiki-compiler.prompt.ts 和卡片生成。'],
    ['services/rag-service/src/brain/knowledge-card-generator.ts', '从 FAQ、章节、字段和表格生成可检索知识卡片。', '分类标签与 Embedding 写入。'],
    ['services/rag-service/src/brain/graph-builder.ts', '构建有限知识关系图（避免全连接爆炸）。', 'Graph 检索权重。'],
    ['services/rag-service/src/brain/gap-detector.ts', '记录检索未覆盖的知识缺口建议。', 'Fallback 话术与运营补库。'],
    ['services/rag-service/src/brain/brain-sync.ts', '串联解析→Wiki→卡片→向量→Graph 的编译主流程。', '编译 API 核心编排。'],
    ['services/rag-service/src/brain/knowledge-store.ts', 'Wiki/Card/Graph/Gap 的 PostgreSQL CRUD。', 'init-db.sql 和 kb-admin 后台。'],
    ['services/rag-service/src/brain/prompts/wiki-compiler.prompt.ts', 'Wiki 结构化 JSON 输出的 LLM Prompt。', 'WikiCompiler 调用。'],
    ['services/rag-service/src/brain/prompts/card-generator.prompt.ts', '知识卡片拆分规则的 LLM Prompt。', 'KnowledgeCardGenerator 调用。'],
    ['services/rag-service/src/brain/prompts/gap-detector.prompt.ts', '知识缺口检测与建议的 LLM Prompt。', 'GapDetector 调用。'],
    ['services/rag-service/src/rag/types.ts', 'Hybrid RAG 请求、响应和候选卡片类型。', 'API 路由与 Retriever。'],
    ['services/rag-service/src/rag/types-internal.ts', 'Query Rewrite 和 Intent 分类内部类型。', 'rag/types.ts 上层封装。'],
    ['services/rag-service/src/rag/config.ts', 'TopK、相似度阈值和四类检索融合权重。', '调参时需同步回归测试。'],
    ['services/rag-service/src/rag/keyword.ts', '中文关键词提取和 BM25 式评分。', '口语化 query 召回补强。'],
    ['services/rag-service/src/rag/query-rewrite.ts', '多意图 query 改写和关键词扩展。', 'IntentClassifier 与 HybridRetriever。'],
    ['services/rag-service/src/rag/intent-classifier.ts', '严格业务类别和多意图识别。', '阈值策略与风控联动。'],
    ['services/rag-service/src/rag/hybrid-retriever.ts', '融合向量、关键词、Metadata 和 Graph 的混合检索。', 'KnowledgeStore 和 Reranker。'],
    ['services/rag-service/src/rag/reranker.ts', '可选 LLM 重排候选卡片。', '失败时回退 Hybrid 原始排序。'],
    ['services/rag-service/src/rag/fallback.ts', '低置信度和无答案时的固定话术。', 'Gap 记录与 AnswerGenerator。'],
    ['services/rag-service/src/rag/answer-generator.ts', '根据召回卡片生成纯文本客服回答。', 'LLM Provider 和 Prompt。'],
    ['services/rag-service/src/rag/rag-service.ts', 'answerWithRag 总入口：检索→重排→生成→高风险转人工。', 'ReplyWorker 通过 rag.service 调用。'],
    ['services/rag-service/src/rag/tests/rag-service.test.ts', '8 个 Hybrid RAG 核心回归测试用例。', '规则变化时需更新预期断言。'],
  ]],
  ['数据库、共享包与交付', [
    ['scripts/init-db.sql', '创建 RAG 相关表：Wiki、Card、Graph、Gap 和向量索引。', 'KnowledgeStore 与向量维度配置。'],
    ['scripts/dev-start.js', '开发启动兼容脚本（旧入口）。', 'run-all.ts 编排。'],
    ['scripts/start-openclaw-detached.ps1', '后台启动便携 OpenClaw 网关。', 'OPENCLAW_PORTABLE_ROOT 路径。'],
    ['scripts/build-windows-portable.ps1', '组装 Windows 便携包：构建、依赖、OpenClaw、扩展和文档。', '排除敏感 data，输出 release 目录。'],
    ['scripts/add-file-comments.mjs', '为本项目核心文件批量添加中文文件头注释（本脚本）。', 'docs/project-files.js 索引。'],
    ['packages/shared/src/index.ts', '跨包共享类型：Platform、UnifiedMessage、RAG 请求响应等。', 'Adapter、API、RPA SDK 共同引用。'],
    ['packages/shared/package.json', '共享类型包定义与构建命令。', '根 build:packages。'],
    ['packages/shared/tsconfig.json', '共享包 TypeScript 编译配置。', '导出路径与 dist 输出。'],
    ['packages/rpa-sdk/src/index.ts', 'RPA SDK：askRagService、createMessageHash 等辅助函数。', 'Watcher 和 Chrome 插件 inbound 链路。'],
    ['packages/rpa-sdk/package.json', 'RPA SDK 包定义与构建命令。', '根 build:packages。'],
    ['packages/rpa-sdk/tsconfig.json', 'RPA SDK TypeScript 编译配置。', '源码导出与 dist 输出。'],
    ['packaging/windows-portable/Start-Customer-AI.bat', '便携包双击启动入口（调用 PowerShell）。', 'Start-Customer-AI.ps1。'],
    ['packaging/windows-portable/Start-Customer-AI.ps1', '便携环境检查与一键启动全部服务。', 'Docker/OpenClaw/RAG/API/扩展状态页。'],
    ['packaging/windows-portable/Stop-Customer-AI.bat', '便携包双击停止入口。', 'Stop-Customer-AI.ps1。'],
    ['packaging/windows-portable/Stop-Customer-AI.ps1', '停止本项目相关进程，不误杀无关服务。', '端口占用清理。'],
    ['packaging/windows-portable/Doctor-Customer-AI.bat', '便携包双击诊断入口。', 'Doctor-Customer-AI.ps1。'],
    ['packaging/windows-portable/Doctor-Customer-AI.ps1', '检查端口、OpenClaw、RAG、API 和扩展文件完整性。', '端口变化时同步文档。'],
    ['packaging/windows-portable/使用说明.txt', '最终用户安装扩展和日常启停说明。', '交付流程变化时同步。'],
  ]],
  ['后台、文档、样例', [
    ['services/rag-service/public/kb-admin.html', '知识库上传、Wiki 编译、卡片、Graph 和 Gap 管理后台。', 'routes/api.ts Schema。'],
    ['docs/project-flow.html', '项目流程和文件职责总览（浏览器可直接打开）。', '流程改动必须同步更新。'],
    ['docs/project-files.js', 'project-flow.html 的文件职责索引数据和搜索渲染。', '新增/移动核心文件时同步。'],
    ['docs/hybrid-rag-and-gbrain.md', 'Hybrid RAG 与 GBrain 架构实现说明。', 'RAG 架构变化时更新。'],
    ['docs/project-walkthrough.md', '新人代码阅读顺序和模块导览。', '目录与入口变化时更新。'],
    ['docs/rpa-limitations-and-risks.md', 'RPA 能力边界、风险和汇报口径。', '真实账号验证结果。'],
    ['examples/test-knowledge-source.json', '旧知识接口 POST 请求体样例。', 'routes/knowledge.ts 调试。'],
    ['examples/test-rpa-inbound.json', 'RPA inbound POST 请求体样例。', 'routes/rpa.ts Schema 验证。'],
    ['samples/kb/common-faq.md', '通用 FAQ 知识库上传测试样例。', 'kb-admin 上传编译测试。'],
    ['samples/kb/douyin-after-sales.md', '抖音售后规则测试样例。', '高风险场景仍应转人工。'],
    ['samples/kb/meituan-dry-cleaning-complete-test-kb.md', '完整洗护业务测试知识（约 80 卡片）。', '8 个 RAG 回归用例。'],
    ['samples/kb/meituan-group-buy.md', '美团团购套餐测试样例。', '套餐检索验证。'],
    ['samples/kb/store-info.csv', '门店信息 CSV 格式测试样例。', 'CSV Parser 和表格卡片。'],
    ['samples/kb/test-questions.md', 'RAG 回复质量测试问题清单。', '手动回归测试。'],
  ]],
];

for (const [group, files] of groups) {
  for (const [path, description, related] of files) {
    register(group, path, description, related);
  }
}

function buildTsHeader(relPath, meta) {
  return [
    '/**',
    ` * @file ${relPath}`,
    ` * @module ${meta.module}`,
    ` * @description ${meta.description}`,
    ` * @see 联动关注：${meta.related}`,
    ' */',
    '',
  ].join('\n');
}

function buildJsHeader(relPath, meta) {
  return buildTsHeader(relPath, meta);
}

function buildSqlHeader(relPath, meta) {
  return [
    `-- @file ${relPath}`,
    `-- @module ${meta.module}`,
    `-- @description ${meta.description}`,
    `-- @see 联动关注：${meta.related}`,
    '',
  ].join('\n');
}

function buildYamlHeader(relPath, meta) {
  return [
    `# @file ${relPath}`,
    `# @module ${meta.module}`,
    `# @description ${meta.description}`,
    `# @see 联动关注：${meta.related}`,
    '',
  ].join('\n');
}

function buildHtmlHeader(relPath, meta) {
  return [
    '<!--',
    `  @file ${relPath}`,
    `  @module ${meta.module}`,
    `  @description ${meta.description}`,
    `  @see 联动关注：${meta.related}`,
    '-->',
    '',
  ].join('\n');
}

function buildCssHeader(relPath, meta) {
  return [
    '/*',
    ` * @file ${relPath}`,
    ` * @module ${meta.module}`,
    ` * @description ${meta.description}`,
    ` * @see 联动关注：${meta.related}`,
    ' */',
    '',
  ].join('\n');
}

function buildTxtHeader(relPath, meta) {
  return [
    `# @file ${relPath}`,
    `# @module ${meta.module}`,
    `# @description ${meta.description}`,
    `# @see 联动关注：${meta.related}`,
    '',
  ].join('\n');
}

function buildMdHeader(relPath, meta) {
  return [
    '<!-- 文件索引注释（不影响 Markdown 渲染）',
    `  @file ${relPath}`,
    `  @module ${meta.module}`,
    `  @description ${meta.description}`,
    `  @see 联动关注：${meta.related}`,
    '-->',
    '',
  ].join('\n');
}

function buildPrismaHeader(relPath, meta) {
  return [
    '/// @file ' + relPath,
    '/// @module ' + meta.module,
    '/// @description ' + meta.description,
    '/// @see 联动关注：' + meta.related,
    '',
  ].join('\n');
}

function buildBatHeader(relPath, meta) {
  return [
    `@REM @file ${relPath}`,
    `@REM @module ${meta.module}`,
    `@REM @description ${meta.description}`,
    `@REM @see 联动关注：${meta.related}`,
    '',
  ].join('\n');
}

function buildPs1Header(relPath, meta) {
  return [
    `# @file ${relPath}`,
    `# @module ${meta.module}`,
    `# @description ${meta.description}`,
    `# @see 联动关注：${meta.related}`,
    '',
  ].join('\n');
}

function hasFileHeader(content) {
  return content.includes('@file ') && (content.startsWith('/**') || content.startsWith('//') || content.startsWith('#') || content.startsWith('--') || content.startsWith('<!--') || content.startsWith('/*') || content.startsWith('@REM') || content.startsWith('///') || content.includes('"_fileDescription"'));
}

function stripOldGeneratedHeader(content) {
  // 移除本脚本之前可能写入的重复头
  if (content.startsWith('/**') && content.includes('@file ')) {
    const end = content.indexOf('*/');
    if (end !== -1) return content.slice(end + 2).replace(/^\s*\n/, '');
  }
  return content;
}

async function patchJson(relPath, meta, fullPath) {
  const raw = await readFile(fullPath, 'utf-8');
  if (raw.includes('"_fileDescription"')) return 'skip';
  const data = JSON.parse(raw);
  const next = {
    _fileDescription: meta.description,
    _fileModule: meta.module,
    _relatedModules: meta.related,
    ...data,
  };
  await writeFile(fullPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return 'updated';
}

async function patchPackageJson(relPath, meta, fullPath) {
  const raw = await readFile(fullPath, 'utf-8');
  const data = JSON.parse(raw);
  if (data._fileDescription === meta.description) return 'skip';
  data._fileDescription = meta.description;
  data._fileModule = meta.module;
  data._relatedModules = meta.related;
  if (!data.description) data.description = meta.description;
  await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  return 'updated';
}

async function patchText(relPath, meta, fullPath, headerBuilder) {
  let content = await readFile(fullPath, 'utf-8');
  if (hasFileHeader(content)) return 'skip';
  content = stripOldGeneratedHeader(content);
  // 保留 //@ts-nocheck 在第一行
  if (content.startsWith('// @ts-nocheck')) {
    const rest = content.replace(/^\/\/ @ts-nocheck\r?\n/, '');
    content = `// @ts-nocheck\n${headerBuilder(relPath, meta)}${rest}`;
  } else {
    content = `${headerBuilder(relPath, meta)}${content}`;
  }
  await writeFile(fullPath, content, 'utf-8');
  return 'updated';
}

async function processFile(relPath) {
  const meta = fileMeta.get(relPath);
  if (!meta) return 'missing-meta';
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) return 'missing-file';

  const ext = relPath.split('.').pop()?.toLowerCase();
  if (relPath.endsWith('.ts') || relPath.endsWith('.tsx') || relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
    return patchText(relPath, meta, fullPath, relPath.endsWith('.ts') || relPath.endsWith('.tsx') ? buildTsHeader : buildJsHeader);
  }
  if (ext === 'json') {
    if (relPath.endsWith('package.json')) return patchPackageJson(relPath, meta, fullPath);
    return patchJson(relPath, meta, fullPath);
  }
  if (ext === 'sql') return patchText(relPath, meta, fullPath, buildSqlHeader);
  if (ext === 'yaml' || ext === 'yml') return patchText(relPath, meta, fullPath, buildYamlHeader);
  if (ext === 'html') return patchText(relPath, meta, fullPath, buildHtmlHeader);
  if (ext === 'css') return patchText(relPath, meta, fullPath, buildCssHeader);
  if (ext === 'txt') return patchText(relPath, meta, fullPath, buildTxtHeader);
  if (ext === 'md') return patchText(relPath, meta, fullPath, buildMdHeader);
  if (ext === 'prisma') return patchText(relPath, meta, fullPath, buildPrismaHeader);
  if (ext === 'bat') return patchText(relPath, meta, fullPath, buildBatHeader);
  if (ext === 'ps1') return patchText(relPath, meta, fullPath, buildPs1Header);
  if (relPath === '.env.example' || relPath === '.gitignore') return patchText(relPath, meta, fullPath, buildTxtHeader);
  return 'unsupported';
}

const results = { updated: 0, skipped: 0, missing: 0, missingMeta: 0, unsupported: 0 };

for (const relPath of fileMeta.keys()) {
  const status = await processFile(relPath);
  if (status === 'updated') results.updated += 1;
  else if (status === 'skip') results.skipped += 1;
  else if (status === 'missing-file') results.missing += 1;
  else if (status === 'missing-meta') results.missingMeta += 1;
  else results.unsupported += 1;
}

console.log(JSON.stringify(results, null, 2));
