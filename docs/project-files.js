/**
 * @file docs/project-files.js
 * @module 后台、文档、样例
 * @description project-flow.html 的文件职责索引数据和搜索渲染。
 * @see 联动关注：新增/移动核心文件时同步。
 */
const fileGroups = [
  ['根目录与配置', [
    ['AGENTS.md', 'AI/Codex 开发约束、编码、注释、架构、安全和流程文档同步规则。', '所有任务开始前读取，禁止删除编码和风控限制。'],
    ['tasks.md', '项目分阶段任务和实施顺序。', '每阶段完成后运行类型检查或最小测试。'],
    ['README.md', '项目入口、启动、接口地址和交付说明。', '端口、启动与交付变化时同步。'],
    ['package.json', '工作区统一启动、构建、迁移和便携包命令。', '各子包 scripts。'],
    ['pnpm-workspace.yaml', '声明 apps、services、packages 工作区和 pnpm allowBuilds。', '新增包或生产依赖构建脚本时更新。'],
    ['pnpm-lock.yaml', '锁定依赖版本。', '由 pnpm 生成，禁止手工编辑。'],
    ['docker-compose.yml', '启动 PostgreSQL/pgvector 与 Redis。', '数据库、Redis 环境变量和端口文档。'],
    ['config/channels.json', '渠道和默认策略。', '平台 Adapter 与知识路由。'],
    ['config/handoff-rules.json', '转人工关键词和置信度规则。', 'Safety、RAG handoff 和测试。'],
    ['config/kb-routes.json', '平台/门店到知识库路由。', 'RAG resolveKbIds。'],
    ['config/rag.json', '旧 RAG 参数兼容配置。', 'Hybrid 配置和环境变量。'],
    ['config/rpa-selectors.example.json', 'RPA 选择器示例。', '插件默认值和现场验证。'],
    ['config/prompts/default.txt', '默认客服 Prompt。', 'PromptRenderer。'],
    ['config/prompts/douyin.txt', '抖音补充 Prompt。', '抖音话术策略。'],
    ['config/prompts/meituan.txt', '美团补充 Prompt。', '美团话术策略。'],
    ['config/prompts/wecom.txt', '企微补充 Prompt。', '企微话术策略。']
  ]],
  ['API 入口与基础设施', [
    ['apps/api/package.json', 'API 依赖及开发、构建、Prisma、Mock 命令。', '根 package.json 和锁文件。'],
    ['apps/api/tsconfig.json', 'API TypeScript 编译配置。', '新增源码目录。'],
    ['apps/api/src/main.ts', '创建 Fastify，注册路由、Worker 和 WebSocket。', '路由、生命周期和端口。'],
    ['apps/api/src/config/env.ts', 'UTF-8 读取根 .env；解析 LLM_PROVIDER（agnes/qianwen/custom/openclaw）与可选 OpenClaw 路径。', '.env.example 和 model-config。'],
    ['apps/api/src/config/model-config.ts', '配置页 LLM/Embedding 热配置：支持 Agnes、千问 DashScope、自定义；JSON + .env + 内存；转发 RAG。', '/guide、openclaw.service、embedding。'],
    ['apps/api/src/dev/run-all.ts', '编排 Docker、可选 OpenClaw、API、RAG、Mock 和专用 Chrome。', '端口、进程清理、README。'],
    ['apps/api/src/lib/prisma.ts', '创建 Prisma Client。', 'schema.prisma 和 DATABASE_URL。'],
    ['apps/api/src/lib/queue.ts', '创建 Redis/BullMQ 连接与 inbound 队列。', 'ReplyWorker 和队列排障。'],
    ['apps/api/prisma/schema.prisma', '门店、会话、消息、草稿和旧知识模型。', '迁移与 Service 查询。'],
    ['apps/api/prisma/migrations/000001_init/migration.sql', '初始化业务表和 pgvector。', '已执行迁移不要重写。'],
    ['apps/api/prisma/migrations/000002_conversation_context/migration.sql', '增加会话摘要字段。', 'MessageService 上下文。']
  ]],
  ['API Adapter 与路由', [
    ['apps/api/src/adapters/types.ts', '平台 Adapter 输入输出类型。', 'UnifiedMessage。'],
    ['apps/api/src/adapters/index.ts', '按平台选择 Adapter。', '新增平台时注册。'],
    ['apps/api/src/adapters/douyin-rpa.adapter.ts', '抖音 RPA 消息转 UnifiedMessage。', 'RPA payload。'],
    ['apps/api/src/adapters/meituan-rpa.adapter.ts', '美团 RPA 消息转 UnifiedMessage。', '插件 shopId/conversationId。'],
    ['apps/api/src/adapters/wecom.adapter.ts', '解析企微客服和应用消息。', 'Webhook、加解密和发送。'],
    ['apps/api/src/routes/health.ts', 'API 健康检查。', 'run-all 与 Doctor。'],
    ['apps/api/src/routes/conversations.ts', '查询会话和消息历史。', 'ConversationService。'],
    ['apps/api/src/routes/knowledge.ts', '旧知识接口兼容层。', '新知识优先使用 8787。'],
    ['apps/api/src/routes/orders.ts', '订单查询测试接口。', 'OrderService。'],
    ['apps/api/src/routes/reply-drafts.ts', '草稿查询、白名单兜底、批准、拒绝、dispatching 与 sent 状态。', 'Extension Gateway、outbound 确认与人工审核。'],
    ['apps/api/src/routes/handoff.ts', '转人工工作台 API：高/中风险草稿列表与标记已处理。', 'handoff.html、SafetyService、ReplyDraft。'],
    ['apps/api/src/routes/rpa.ts', 'RPA inbound/outbound、配置和扩展状态。', 'MessageService、插件。'],
    ['apps/api/src/routes/webhooks.wecom.ts', '企微 URL 校验和回调入口。', 'Crypto、Adapter、Client。']
  ]],
  ['API Service 与 Worker', [
    ['apps/api/src/services/conversation.service.ts', '按平台、门店、客户创建隔离会话。', 'Prisma 唯一键。'],
    ['apps/api/src/services/message.service.ts', '消息去重、入库、同正文短时去重、摘要；历史含 pending 草稿轮次。', 'RPA outbound、ReplyDraft、多轮记忆。'],
    ['apps/api/src/services/embedding.service.ts', 'API 旧知识表 Embedding 兼容实现。', '新检索由 8787 负责。'],
    ['apps/api/src/services/knowledge.service.ts', '旧知识片段写入和搜索。', '避免与 rag-service 再次分叉。'],
    ['apps/api/src/services/rag.service.ts', '调用 8787 Hybrid 检索并兼容旧 Chunk。', 'ReplyWorker、RAG API Key。'],
    ['apps/api/src/services/openclaw.service.ts', 'LLM 人设提示（含当前会话平台渠道）、多轮+摘要、本地兜底（读 model-config）。', 'ReplyWorker、safety.service、/guide。'],
    ['apps/api/src/services/order.service.ts', '订单识别、多轮等待订单号判断、公司系统查询和脱敏。', '订单 Adapter/TODO。'],
    ['apps/api/src/services/order-routing.test.ts', '回归测试多轮纯订单号路由和普通编号防误判。', 'OrderService 与 ReplyWorker 路由顺序。'],
    ['apps/api/src/services/safety.service.ts', '高风险关键词/寒暄豁免、禁止承诺和自动发送判定。', 'AGENTS 风控、handoff。'],
    ['apps/api/src/services/send.service.ts', '选择平台发送出口并检查全局开关。', '企微 Client、RPA 开关。'],
    ['apps/api/src/services/wecom-client.service.ts', '企微 Token 和官方发送请求。', '企微环境变量。'],
    ['apps/api/src/services/wecom-crypto.service.ts', '企微签名验证和消息加解密。', 'Token/AES Key。'],
    ['apps/api/src/utils/chunk-text.ts', '旧知识文本切片。', '不要用于替代知识卡片。'],
    ['apps/api/src/utils/terminal-log.ts', '终端彩色业务日志：检索、草稿、推送、发送按钮点击结果。', 'Windows 终端需支持 ANSI；仅开发排查用。'],
    ['apps/api/src/workers/reply.worker.ts', '消费消息队列；先做多轮订单路由，非订单才执行 RAG，再调用 LLM、风控和生成草稿。', '回复主链路排障入口。']
  ]],
  ['RPA 与 Chrome 插件', [
    ['apps/api/src/rpa/extension-gateway.ts', '本地 WebSocket、expected 登记、草稿推送与孤儿草稿补推。', 'duplicated 不删 expected；draft 到位后由插件切回话。'],
    ['apps/api/src/rpa/customer-allowlist.ts', '美团/抖音真实灰度客户白名单判断；空列表放行全部。', 'allowlist-config、rpa.ts 和插件同步。'],
    ['apps/api/src/rpa/allowlist-config.ts', '白名单运行时读写（local JSON + .env 同步）。', '配置页 /rpa/allowlist、customer-allowlist。'],
    ['apps/api/src/rpa/mock-chat-server.ts', '3100 多会话 Mock、随机消息和页面发送。', 'content.js 选择器。'],
    ['apps/api/src/rpa/selector-config.ts', '读写平台 RPA 选择器。', 'RPA 配置路由。'],
    ['apps/api/src/rpa/browser.ts', 'Playwright persistent context 兼容启动器。', '非默认模式。'],
    ['apps/api/src/rpa/dom-message-watcher.ts', '旧 Playwright DOM 监听和发送。', '不能与默认插件重复运行。'],
    ['apps/api/src/rpa/mock-site.watcher.ts', '旧 Mock Playwright Watcher。', '仅 playwright 模式。'],
    ['apps/api/src/rpa/douyin.watcher.ts', '抖音 Playwright Adapter 骨架。', '真实接口未确认保留 TODO。'],
    ['apps/api/src/rpa/meituan.watcher.ts', '美团 Playwright Adapter 骨架。', '默认使用插件。'],
    ['apps/api/src/rpa/meituan-real.watcher.ts', '美团真实页 Playwright 兼容入口。', '真实账号灰度。'],
    ['extensions/customer-ai-rpa/manifest.json', 'MV3 权限、域名和脚本声明。', '版本与权限。'],
    ['extensions/customer-ai-rpa/douyin-main-click.js', '抖音 MAIN world 会话点击脚本。', 'background.js executeScript。'],
    ['extensions/customer-ai-rpa/background.js', 'WebSocket、设置迁移、会话路由和重连。', 'Gateway 协议。'],
    ['extensions/customer-ai-rpa/content.js', 'DOM 采集、未读串行锁、草稿到位后强制切回目标会话再回填/发送。', 'waiting-draft/applying-draft 期间禁止其它未读抢切。'],
    ['extensions/customer-ai-rpa/popup.html', '扩展设置面板结构。', 'popup.js 字段。'],
    ['extensions/customer-ai-rpa/popup.js', '配置持久化、状态和 AI 选择器识别。', 'Chrome storage。'],
    ['extensions/customer-ai-rpa/popup.css', '扩展弹窗样式。', '窄屏与溢出。'],
    ['extensions/customer-ai-rpa/README.md', '安装、测试和安全说明。', '插件行为变化时更新。']
  ]],
  ['RAG Service 兼容层', [
    ['services/rag-service/package.json', '8787 依赖、构建和测试。', '锁文件。'],
    ['services/rag-service/tsconfig.json', 'RAG TypeScript 严格配置。', '所有新增源码。'],
    ['services/rag-service/src/main.ts', '启动 8787 Fastify。', '路由和端口。'],
    ['services/rag-service/src/config/env.ts', 'Embedding、LLM、阈值；OpenClaw token 可按包内相对路径自动读取。', '.env.example。'],
    ['services/rag-service/src/config/runtime-config.ts', 'Embedding 运行时热覆盖（配置页同步）。', 'embedding.ts、API model-config。'],
    ['services/rag-service/src/providers/embedding.ts', 'Embedding Provider（按次读热配置）。', '向量维度、runtime-config。'],
    ['services/rag-service/src/routes/admin-page.ts', '提供 /kb-admin 页面。', 'kb-admin.html。'],
    ['services/rag-service/src/routes/api.ts', 'KB、编译、卡片、Graph、Gap、检索和回答 API。', 'Brain 与 Hybrid。'],
    ['services/rag-service/src/parsers/file-parser.ts', 'TXT/MD/CSV/PDF/DOCX/XLSX 解析。', '扫描 PDF 仍需 OCR Adapter。'],
    ['services/rag-service/src/providers/llm.ts', 'Mock/OpenAI/Agenes/OpenClaw Provider。', 'Wiki、Rerank、Answer。'],
    ['services/rag-service/src/services/rag-application.ts', '旧 Chunk ingest/chat 兼容链路。', '新链路优先 Hybrid 卡片。'],
    ['services/rag-service/src/services/store.ts', '旧 KB/File 缓存和 PostgreSQL 恢复。', 'init-db、uploads。'],
    ['services/rag-service/src/services/splitter.ts', '旧 Chunk 切分。', '卡片不能退化为机械切片。'],
    ['services/rag-service/src/services/handoff.ts', '旧 RAG 转人工规则。', 'handoff-rules。'],
    ['services/rag-service/src/services/prompt-renderer.ts', '旧 RAG Prompt 组合。', 'config/prompts。'],
    ['services/rag-service/src/vector-store/vector-store.ts', '向量存储接口。', 'memory/pgvector。'],
    ['services/rag-service/src/vector-store/index.ts', '选择向量存储实现。', 'VECTOR_STORE。'],
    ['services/rag-service/src/vector-store/memory-vector-store.ts', '内存向量检索。', '仅测试。'],
    ['services/rag-service/src/vector-store/pg-vector-store.ts', 'Chunk pgvector 写入和检索。', '维度与索引。'],
    ['services/rag-service/src/types.ts', '旧 RAG 类型占位。', '新类型在 brain/rag。']
  ]],
  ['GBrain 与 Hybrid RAG', [
    ['services/rag-service/src/brain/types.ts', 'Wiki、Card、Graph、Gap 类型。', '数据库和 API。'],
    ['services/rag-service/src/brain/config.ts', '文档长度和卡片数量配置。', '编译成本。'],
    ['services/rag-service/src/brain/document-parser.ts', '统一 ParsedDocument。', 'file-parser。'],
    ['services/rag-service/src/brain/wiki-compiler.ts', 'LLM Wiki 与本地回退。', 'Wiki Prompt、卡片生成。'],
    ['services/rag-service/src/brain/knowledge-card-generator.ts', '从 FAQ、章节、字段和表格生成卡片。', '分类与 Embedding。'],
    ['services/rag-service/src/brain/graph-builder.ts', '生成有限知识关系。', '避免全连接。'],
    ['services/rag-service/src/brain/gap-detector.ts', '记录知识缺口建议。', 'Fallback。'],
    ['services/rag-service/src/brain/brain-sync.ts', '串联解析、Wiki、卡片、向量和 Graph。', '编译 API 核心。'],
    ['services/rag-service/src/brain/knowledge-store.ts', 'Wiki/Card/Graph/Gap PostgreSQL CRUD。', 'init-db 和后台。'],
    ['services/rag-service/src/brain/prompts/wiki-compiler.prompt.ts', 'Wiki JSON Prompt。', 'WikiCompiler。'],
    ['services/rag-service/src/brain/prompts/card-generator.prompt.ts', '卡片拆分规则。', 'CardGenerator。'],
    ['services/rag-service/src/brain/prompts/gap-detector.prompt.ts', 'Gap 建议约束。', 'GapDetector。'],
    ['services/rag-service/src/rag/types.ts', 'Hybrid 请求、响应和候选类型。', 'API 与 Retriever。'],
    ['services/rag-service/src/rag/types-internal.ts', 'Rewrite/Intent 内部类型。', 'types.ts。'],
    ['services/rag-service/src/rag/config.ts', 'TopK、阈值和四类权重。', '调参同步测试。'],
    ['services/rag-service/src/rag/keyword.ts', '中文关键词提取和评分。', '口语召回。'],
    ['services/rag-service/src/rag/query-rewrite.ts', '多意图改写和关键词扩展。', 'Intent/Hybrid。'],
    ['services/rag-service/src/rag/intent-classifier.ts', '严格类别和多意图识别。', '阈值与风控。'],
    ['services/rag-service/src/rag/hybrid-retriever.ts', '融合向量、关键词、Metadata 和 Graph。', 'KnowledgeStore。'],
    ['services/rag-service/src/rag/reranker.ts', '可选 LLM 重排。', '失败回退 Hybrid。'],
    ['services/rag-service/src/rag/fallback.ts', '阈值和无答案话术。', 'Gap 与 Answer。'],
    ['services/rag-service/src/rag/answer-generator.ts', '根据卡片生成纯文本客服回答。', 'LLM Provider。'],
    ['services/rag-service/src/rag/rag-service.ts', 'answerWithRag 总入口和高风险转人工。', 'ReplyWorker。'],
    ['services/rag-service/src/rag/tests/rag-service.test.ts', '8 个核心回归测试。', '规则变化更新预期。']
  ]],
  ['数据库、共享包与交付', [
    ['scripts/init-db.sql', '创建 RAG、Wiki、Card、Graph、Gap 和索引。', 'KnowledgeStore 与向量维度。'],
    ['scripts/dev-start.js', '开发启动兼容脚本。', 'run-all。'],
    ['scripts/start-openclaw-detached.ps1', '后台启动便携 OpenClaw。', '便携根目录。'],
    ['scripts/build-windows-portable.ps1', '组装 Windows 便携包：便携 Node、扩展、文档、样例和 Prisma Client（不捆绑 OpenClaw）。', 'runtime/node-win-x64、敏感 data 排除、release。'],
    ['packages/shared/src/index.ts', '跨包 UnifiedMessage 等类型。', 'Adapter/API/SDK。'],
    ['packages/shared/package.json', '共享包定义。', '根构建。'],
    ['packages/shared/tsconfig.json', '共享包编译配置。', '导出路径。'],
    ['packages/rpa-sdk/src/index.ts', 'RPA SDK 类型和辅助函数。', 'Watcher。'],
    ['packages/rpa-sdk/package.json', 'RPA SDK 包定义。', '根构建。'],
    ['packages/rpa-sdk/tsconfig.json', 'RPA SDK 编译配置。', '源码导出。'],
    ['packaging/windows-portable/Start-Customer-AI.bat', '双击启动入口。', 'Start PowerShell。'],
    ['packaging/windows-portable/Start-Customer-AI.ps1', '便携环境检查与一键启动；非 openclaw 时跳过本机网关。', 'Docker/LLM/RAG/API/引导页 /guide。'],
    ['packaging/windows-portable/getting-started.html', '便携包启动引导页（LLM/Embedding 配置、白名单、快捷入口、状态检测）。', '/guide、model-config、Start-Customer-AI.ps1。'],
    ['packaging/windows-portable/handoff.html', '最小转人工工作台页面。', '/handoff 路由、ReplyDraft 高/中风险。'],
    ['docs/deployment-guide.html', '源码部署、Windows 便携交付、生产灰度；优先 /guide 配 LLM/Embedding。', 'README、打包脚本、project-flow.html。'],
    ['apps/api/src/routes/guide.ts', '提供 /guide 引导页与状态；LLM/Embedding GET·PUT·test；白名单旁配置表单。', 'getting-started.html、model-config、便携启动。'],
    ['packaging/windows-portable/Stop-Customer-AI.bat', '双击停止入口。', 'Stop PowerShell。'],
    ['packaging/windows-portable/Stop-Customer-AI.ps1', '停止本项目服务。', '不得误杀无关进程。'],
    ['packaging/windows-portable/Doctor-Customer-AI.bat', '双击诊断入口。', 'Doctor PowerShell。'],
    ['packaging/windows-portable/Doctor-Customer-AI.ps1', '检查端口、LLM/OpenClaw、RAG、API 和扩展文件。', '端口变化同步。'],
    ['packaging/windows-portable/使用说明.txt', '最终用户安装扩展和日常启停说明。', '交付变化同步。']
  ]],
  ['后台、文档、样例与生成物', [
    ['services/rag-service/public/kb-admin.html', '知识上传、Wiki 编译、卡片、Graph 和 Gap 后台。', 'RAG API Schema。'],
    ['docs/project-flow.html', '项目流程和文件职责总览。', '所有流程改动必须同步。'],
    ['docs/extension-rpa-flow.html', 'Chrome 扩展 RPA 逻辑梳理（会话锁、expected、草稿推送）。', 'content.js、background.js、extension-gateway。'],
    ['docs/code-review-guide.html', '代码整体梳理顺序与可勾选进度导览。', '新人接手、自查时优先打开。'],
    ['docs/project-files.js', '流程页文件职责数据和搜索渲染。', '新增、删除或改名核心文件时同步。'],
    ['docs/hybrid-rag-and-gbrain.md', 'Hybrid/GBrain 实现说明。', 'RAG 架构变化。'],
    ['docs/project-walkthrough.md', '代码阅读顺序（文字版）。', '目录与入口变化；HTML 版见 code-review-guide.html。'],
    ['docs/rpa-limitations-and-risks.md', 'RPA 风险和汇报口径。', '真实账号验证结果。'],
    ['examples/test-knowledge-source.json', '旧知识接口请求样例。', 'knowledge 路由。'],
    ['examples/test-rpa-inbound.json', 'RPA inbound 样例。', 'RPA Schema。'],
    ['samples/kb/common-faq.md', '通用 FAQ 样例。', '上传编译测试。'],
    ['samples/kb/douyin-after-sales.md', '抖音售后样例。', '高风险仍转人工。'],
    ['samples/kb/meituan-dry-cleaning-complete-test-kb.md', '完整洗护测试知识。', '80 卡片和 8 用例。'],
    ['samples/kb/meituan-group-buy.md', '美团团购样例。', '套餐检索。'],
    ['samples/kb/store-info.csv', '门店 CSV 样例。', 'CSV Parser。'],
    ['samples/kb/test-questions.md', 'RAG 测试问题。', '回归测试。'],
    ['services/rag-service/uploads/**', '运行时上传原文件。', '生成物，不手工编辑或提交敏感资料。']
  ]]
];

const tbody = document.getElementById('file-responsibilities');
const filter = document.getElementById('file-filter');
function renderFiles() {
  const query = filter.value.trim().toLowerCase();
  tbody.replaceChildren();
  for (const [group, files] of fileGroups) {
    const visible = files.filter((item) => !query || `${item[0]} ${item[1]} ${item[2]}`.toLowerCase().includes(query));
    if (!visible.length) continue;
    const groupRow = document.createElement('tr');
    groupRow.className = 'group-row';
    groupRow.innerHTML = '<td colspan="3"></td>';
    groupRow.firstElementChild.textContent = `${group}（${visible.length}）`;
    tbody.appendChild(groupRow);
    for (const [path, responsibility, related] of visible) {
      const row = document.createElement('tr');
      row.innerHTML = '<td class="file-path"></td><td></td><td></td>';
      row.children[0].textContent = path;
      row.children[1].textContent = responsibility;
      row.children[2].textContent = related;
      tbody.appendChild(row);
    }
  }
}
filter.addEventListener('input', renderFiles);
renderFiles();
