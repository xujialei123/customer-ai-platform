// @ts-nocheck
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { env } from '../config/env.js';
import { createEmbeddingProvider } from '../providers/embedding.js';
import { createLLMProvider } from '../providers/llm.js';
import { getFileType, parseKnowledgeFile, sha256File } from '../parsers/file-parser.js';
import { createVectorStore } from '../vector-store/index.js';
import { splitDocuments } from './splitter.js';
import { knowledgePersistence, repository } from './store.js';
import { HandoffService, loadHandoffConfig } from './handoff.js';
import { PromptRenderer } from './prompt-renderer.js';
export class RagApplication {
    embeddingProvider = createEmbeddingProvider();
    llmProvider = createLLMProvider();
    vectorStore = createVectorStore();
    promptRenderer = new PromptRenderer();
    bootstrapped = false;
    async bootstrapFromUploads() {
        // 服务重启后从持久化元数据恢复文件；只有缺少 chunk 的文件才重新 ingest，避免重复调用付费 API。
        if (this.bootstrapped)
            return;
        this.bootstrapped = true;
        await knowledgePersistence.initialize();
        const uploadRoot = resolve(process.cwd(), env.UPLOAD_DIR);
        const kbDirs = await readdir(uploadRoot, { withFileTypes: true }).catch(() => []);
        let restoredFiles = 0;
        let restoredChunks = 0;
        for (const kbDir of kbDirs) {
            if (!kbDir.isDirectory() || !kbDir.name.startsWith('kb_'))
                continue;
            const kbId = kbDir.name;
            const now = new Date().toISOString();
            if (!repository.knowledgeBases.has(kbId)) {
                const restoredKb = {
                    id: kbId,
                    name: `已上传知识库 ${kbId.slice(0, 10)}`,
                    description: '服务启动时从 uploads 目录恢复',
                    createdAt: now,
                    updatedAt: now
                };
                repository.knowledgeBases.set(kbId, restoredKb);
                await knowledgePersistence.saveKnowledgeBase(restoredKb);
            }
            const dirPath = resolve(uploadRoot, kbDir.name);
            const files = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
            for (const fileEntry of files) {
                if (!fileEntry.isFile())
                    continue;
                const parsed = parseStoredUploadName(fileEntry.name);
                // 数据库已恢复的文件不重复解析，避免每次重启都重新生成向量。
                if (repository.files.has(parsed.fileId))
                    continue;
                const filePath = resolve(dirPath, fileEntry.name);
                const file = {
                    id: parsed.fileId,
                    kbId,
                    fileName: parsed.fileName,
                    fileType: getFileType(parsed.fileName),
                    filePath,
                    fileHash: await sha256File(filePath),
                    parseStatus: 'uploaded',
                    chunkCount: 0,
                    createdAt: now,
                    updatedAt: now
                };
                repository.files.set(file.id, file);
                await knowledgePersistence.saveFile(file);
                try {
                    const result = await this.ingestFile(kbId, file.id);
                    restoredFiles += 1;
                    restoredChunks += result.chunkCount;
                }
                catch (error) {
                    await this.updateFile(file, {
                        parseStatus: 'failed',
                        errorMessage: error instanceof Error ? error.message : String(error)
                    });
                }
            }
        }
        if (restoredFiles > 0) {
            console.log(`[RAG] 已从 uploads 恢复 ${restoredFiles} 个文件，${restoredChunks} 个 chunk`);
        }
    }
    async createKb(input) {
        // 知识库 ID 由服务生成，名称只用于管理展示，平台路由应绑定稳定 ID 而不是名称。
        const now = new Date().toISOString();
        const kb = {
            id: `kb_${nanoid()}`,
            name: input.name,
            description: input.description,
            createdAt: now,
            updatedAt: now
        };
        repository.knowledgeBases.set(kb.id, kb);
        await knowledgePersistence.saveKnowledgeBase(kb);
        return kb;
    }
    async saveUpload(input) {
        // 原始文件先持久化并计算 hash，解析失败时仍可在管理页定位和重试。
        if (!repository.knowledgeBases.has(input.kbId))
            throw new Error('知识库不存在');
        const fileType = getFileType(input.fileName);
        const supported = env.SUPPORTED_FILE_TYPES.split(',').map((item) => item.trim());
        if (!supported.includes(fileType))
            throw new Error(`不支持的文件类型：${fileType}`);
        const uploadDir = resolve(process.cwd(), env.UPLOAD_DIR, input.kbId);
        await mkdir(uploadDir, { recursive: true });
        const fileId = `file_${nanoid()}`;
        const safeName = input.fileName.replace(/[\\/:*?"<>|]/g, '_');
        const filePath = resolve(uploadDir, `${fileId}_${safeName}`);
        await writeFile(filePath, input.data, 'utf-8');
        const now = new Date().toISOString();
        const file = {
            id: fileId,
            kbId: input.kbId,
            fileName: input.fileName,
            fileType,
            filePath,
            fileHash: await sha256File(filePath),
            parseStatus: 'uploaded',
            chunkCount: 0,
            createdAt: now,
            updatedAt: now
        };
        repository.files.set(file.id, file);
        await knowledgePersistence.saveFile(file);
        return file;
    }
    async ingestFile(kbId, fileId) {
        // ingest 按“解析 -> 切片 -> 全量向量化 -> 替换旧切片”执行，避免半成品覆盖可用索引。
        const file = repository.files.get(fileId);
        if (!file || file.kbId !== kbId)
            throw new Error('文件不存在或不属于当前知识库');
        try {
            await this.updateFile(file, { parseStatus: 'parsing', errorMessage: undefined });
            const parts = await parseKnowledgeFile(file.filePath, file.fileName);
            await this.updateFile(file, { parseStatus: 'parsed' });
            const chunks = splitDocuments({ kbId, fileId, fileName: file.fileName, parts });
            await this.updateFile(file, { parseStatus: 'embedding' });
            const embeddings = await this.embeddingProvider.embedTexts(chunks.map((chunk) => chunk.content));
            chunks.forEach((chunk, index) => {
                chunk.embedding = embeddings[index] ?? [];
            });
            // 先确保新向量全部生成成功，再删除该文件旧切片，避免重新 ingest 后新旧 chunk 混合召回。
            await this.vectorStore.deleteByFileId(fileId);
            for (const [chunkId, storedChunk] of repository.chunks.entries()) {
                if (storedChunk.fileId === fileId)
                    repository.chunks.delete(chunkId);
            }
            await this.vectorStore.upsertChunks(chunks);
            await this.updateFile(file, { parseStatus: 'completed', chunkCount: chunks.length });
            return { fileId, chunkCount: chunks.length };
        }
        catch (error) {
            await this.updateFile(file, {
                parseStatus: 'failed',
                errorMessage: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    async search(input) {
        // 查询文本必须使用与文档相同的模型和维度生成向量，否则余弦分数没有可比性。
        const queryEmbedding = await this.embeddingProvider.embedText(input.query);
        return this.vectorStore.search({
            kbIds: input.kbIds,
            queryEmbedding,
            topK: input.topK ?? env.RAG_TOP_K,
            queryText: input.query
        });
    }
    async chat(input) {
        // chat 负责串联寒暄、风控、检索、证据判断和日志，不承担平台发送职责。
        const handoff = new HandoffService(await loadHandoffConfig());
        const session = repository.upsertSession({
            platform: input.platform,
            shopId: input.shopId,
            externalUserId: input.externalUserId ?? input.sessionId,
            externalUserName: input.externalUserName
        });
        repository.messages.push({
            id: `msg_${nanoid()}`,
            sessionId: session.id,
            platform: input.platform,
            role: 'user',
            content: input.userMessage,
            rawPayload: input,
            createdAt: new Date().toISOString()
        });
        const kbIds = this.resolveKbIds(input.platform, input.shopId);
        let answer = '这个问题我需要帮您转人工确认一下，请稍等。';
        let confidence = 0;
        let results = [];
        let needHuman = false;
        let reason = '';
        const smallTalkReply = matchDeterministicSmallTalk(input.userMessage);
        if (smallTalkReply) {
            // 纯寒暄不包含门店事实，使用审核过的固定话术即可；不浪费 Embedding/LLM 调用，也不会因无召回误转人工。
            answer = smallTalkReply;
            confidence = 1;
        }
        else {
            const pre = handoff.checkBeforeRetrieval(input.userMessage, session.aiReplyCount);
            if (pre.needHuman) {
            needHuman = true;
            reason = pre.reason;
            answer = pre.fallbackReply;
            }
            else {
                results = await this.search({ platform: input.platform, shopId: input.shopId, kbIds, query: input.userMessage, topK: env.RAG_TOP_K });
                confidence = results[0]?.score ?? 0;
                const after = handoff.checkAfterRetrieval(results);
                if (after.needHuman) {
                    needHuman = true;
                    reason = after.reason;
                    answer = after.fallbackReply;
                }
                else {
                    try {
                        const prompt = await this.promptRenderer.render({
                            platform: input.platform,
                            history: input.history ?? [],
                            results,
                            requiresEvidenceReview: after.requiresEvidenceReview,
                            question: input.userMessage
                        });
                        answer = sanitizeCustomerReply(await this.llmProvider.chat({ platform: input.platform, prompt, history: input.history })).slice(0, env.RPA_MAX_REPLY_CHARS);
                        // 中间分数段交给模型判断；模型返回固定转人工话术时，后端仍要落成 needHuman，禁止自动发送。
                        if (/转人工确认|转人工处理|帮您转人工/.test(answer)) {
                            needHuman = true;
                            reason = after.requiresEvidenceReview ? 'AI 判断低置信候选不足以回答' : 'AI 判断知识证据不足';
                        }
                        else {
                            session.aiReplyCount += 1;
                        }
                    }
                    catch (error) {
                        needHuman = true;
                        reason = error instanceof Error ? error.message : String(error);
                        answer = handoff.needHuman('LLM 调用失败').fallbackReply;
                    }
                }
            }
        }
        session.needHuman = needHuman;
        repository.messages.push({
            id: `msg_${nanoid()}`,
            sessionId: session.id,
            platform: input.platform,
            role: 'assistant',
            content: answer,
            rawPayload: { needHuman, reason },
            createdAt: new Date().toISOString()
        });
        const log = {
            id: `log_${nanoid()}`,
            sessionId: session.id,
            platform: input.platform,
            shopId: input.shopId,
            kbIds,
            query: input.userMessage,
            matchedChunks: results,
            answer,
            confidence,
            needHuman,
            reason,
            createdAt: new Date().toISOString()
        };
        repository.retrievalLogs.unshift(log);
        console.log(`[${input.platform}] 用户：${input.userMessage}`);
        console.log(`[RAG] kb=${kbIds.join(',')} 最高 score=${confidence.toFixed(2)} needHuman=${needHuman}`);
        console.log(`[AI] ${answer}`);
        console.log(env.RPA_DRY_RUN ? '[DRY_RUN] 未发送' : '[SEND] 允许发送');
        return {
            answer,
            confidence,
            shouldReply: !needHuman,
            needHuman,
            reason,
            sources: results.map((item) => ({ fileName: item.fileName, page: item.page, score: item.score }))
        };
    }
    async updateFile(file, patch) {
        const updated = { ...file, ...patch, updatedAt: new Date().toISOString() };
        repository.files.set(file.id, updated);
        await knowledgePersistence.saveFile(updated);
    }
    resolveKbIds(platform, shopId) {
        // MVP 内存模式下没有路由表时，优先按 config/channels.json 约定；若配置里的 kb 尚未创建，则退回全部知识库方便本地调试。
        const configured = defaultKbIds(platform, shopId).filter((kbId) => repository.knowledgeBases.has(kbId));
        return configured.length ? configured : [...repository.knowledgeBases.keys()];
    }
}
function matchDeterministicSmallTalk(message) {
    // 仅匹配整句白名单；“你好，几点营业”包含业务问题，必须继续进入 RAG。
    const normalized = message.trim().toLowerCase().replace(/[\s，。！？,.!?~～]+/g, '');
    if (/^(你好|您好|哈喽|嗨|hello|hi|在|在吗|有人吗|在不在|早上好|下午好|晚上好)[啊呀吗呢哦哟]*$/.test(normalized))
        return '您好，请问有什么可以帮您的呢？';
    if (/^(谢谢|感谢|多谢|辛苦了|谢谢你|谢谢您)[啊呀啦了]*$/.test(normalized))
        return '不客气，很高兴为您服务。';
    if (/^(再见|拜拜|下次见|回头见)[啊呀啦了]*$/.test(normalized))
        return '好的，再见，祝您生活愉快！';
    if (/^(好的|好|可以|知道了|明白了|收到|嗯嗯|行)[啊呀啦了]*$/.test(normalized))
        return '好的，如有其他问题可以继续告诉我。';
    return null;
}
function defaultKbIds(platform, _shopId) {
    // 当前是 MVP 默认路由；生产必须配置真实知识库 ID，不能长期依赖“全部知识库”回退。
    if (platform === 'douyin')
        return ['kb_common', 'kb_douyin', 'kb_after_sales'];
    if (platform === 'meituan')
        return ['kb_common', 'kb_meituan', 'kb_after_sales'];
    if (platform === 'wecom')
        return ['kb_common', 'kb_product', 'kb_wecom'];
    return [];
}
function parseStoredUploadName(name) {
    if (name.startsWith('file_') && name.length > 27 && name[26] === '_') {
        return {
            fileId: name.slice(0, 26),
            fileName: name.slice(27)
        };
    }
    return {
        fileId: `file_${nanoid()}`,
        fileName: name
    };
}
function sanitizeCustomerReply(reply) {
    // 清理模型可能带出的内部技术描述，避免向客户暴露 RAG、Prompt 或系统实现细节。
    const fallback = '这个问题我需要帮您转人工确认一下，请稍等。';
    const text = reply.trim();
    // 客服回复不能暴露系统实现。如果模型说“知识库没有说明”，对用户只表现为转人工确认。
    if (/(知识库|内部资料|资料库|检索|向量|模型|RAG|系统).{0,12}(没有|暂无|未|不清楚|无法|不能确定|没写|没说明)/i.test(text)
        || /(没有|暂无|未|不清楚|无法|不能确定|没写|没说明).{0,12}(知识库|内部资料|资料库|检索|向量|模型|RAG|系统)/i.test(text)) {
        return fallback;
    }
    return text
        .replace(/根据(知识库|内部资料|资料库|检索结果|系统资料)[，,：:]?/g, '')
        .replace(/(知识库|内部资料|资料库|检索结果|向量检索|RAG|模型)(中|里)?/gi, '')
        .replace(/关于.*?没有详细说明[，,。]?/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[，,。；;：:\s]+/, '')
        .trim() || fallback;
}
