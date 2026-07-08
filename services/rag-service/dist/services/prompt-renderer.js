// @ts-nocheck
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
const defaultPrompt = `你是一个企业客服助手。

请严格根据【知识库内容】回答用户问题。
如果知识库中没有相关信息，不要编造答案。
如果无法确定，请回复：这个问题我需要帮您转人工确认一下。

回答要求：
1. 语气自然、简洁、礼貌。
2. 不要暴露“知识库”“向量检索”“模型”“RAG”“资料库”“系统”等技术细节。
3. 不要承诺知识库里没有的信息。
4. 涉及价格、退款、预约、营业时间时，必须以知识库内容为准。
5. 如果用户情绪不满，先安抚，再给解决方案。
6. 回复不要太长，优先 1 到 3 句话。
7. 不要输出 Markdown 表格。
8. 如果平台是抖音或美团，回复要更短。
9. 如果平台是企微，可以稍微正式一点。
10. 最终回复中禁止出现“知识库”“检索”“模型”“RAG”等词。如果资料没有明确答案，只说“这个问题我需要帮您转人工确认一下，请稍等。”，不要解释原因。

【平台】
{{platform}}

【历史对话】
{{history}}

【知识库内容】
{{context}}

【用户问题】
{{question}}

请生成客服可直接发送给用户的回复。`;
export class PromptRenderer {
    async render(input) {
        // Prompt 同时包含近期历史、TopK 证据和分数；最终答案仍不得向客户暴露这些内部信息。
        const template = await this.loadTemplate(input.platform);
        const history = input.history
            .slice(-env.RAG_HISTORY_TURNS)
            .map((item) => `${item.role}: ${item.content}`)
            .join('\n') || '无';
        const evidenceRule = input.requiresEvidenceReview
            ? '以下是低置信候选片段。请先判断它们是否直接回答用户问题；只有证据明确时才能作答，否则必须返回固定转人工话术。'
            : '以下是候选片段。回答中的事实必须能够从片段中直接找到依据。';
        const context = input.results
            .map((item, index) => `${index + 1}. [片段ID=${item.chunkId}] ${item.content}\n来源：${item.fileName}${item.page ? ` page=${item.page}` : ''} score=${item.score.toFixed(2)}`)
            .join('\n\n')
            .slice(0, env.RAG_MAX_CONTEXT_CHARS) || '无';
        const reviewedContext = `${evidenceRule}\n\n${context}`;
        return template
            .replaceAll('{{platform}}', input.platform)
            .replaceAll('{{history}}', history)
            .replaceAll('{{context}}', reviewedContext)
            .replaceAll('{{question}}', input.question);
    }
    async loadTemplate(platform) {
        // 平台模板允许调整语气和长度，缺失时回退 default，不能因新增渠道导致整个回复链路失败。
        const root = resolve(process.cwd(), '../../config/prompts');
        for (const fileName of [`${platform}.txt`, 'default.txt']) {
            try {
                return await readFile(resolve(root, fileName), 'utf-8');
            }
            catch {
                // 没有平台专属 prompt 时使用默认模板，避免平台新增时还要先补文件。
            }
        }
        return defaultPrompt;
    }
}
