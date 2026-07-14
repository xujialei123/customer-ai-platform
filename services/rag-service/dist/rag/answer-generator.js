/**
 * @file services/rag-service/src/rag/answer-generator.ts
 * @module GBrain 与 Hybrid RAG
 * @description 根据召回卡片生成纯文本客服回答。
 * @see 联动关注：LLM Provider 和 Prompt。
 */
import { createLLMProvider } from '../providers/llm.js';
import { NO_ANSWER_TEXT } from './fallback.js';
function looksLikeInternalInstruction(text) {
    if (!text)
        return true;
    // 知识库里的 AI 操作说明常含这些口吻；命中则禁止原样给客户。
    return /(顾客只说|应先礼貌|不得猜测|不得根据昵称|不得编造|客服不得|AI\s*不得|只读订单查询 Adapter|内部约束|不要原样发给)/.test(text);
}
function sanitizeAnswer(answer, query = '') {
    const text = answer.trim().replace(/\*\*(.*?)\*\*/gs, '$1').replace(/^#{1,6}\s+/gm, '');
    if (!text || /(知识库|RAG|检索结果|模型)/i.test(text))
        return NO_ANSWER_TEXT;
    if (looksLikeInternalInstruction(text)) {
        if (/订单|洗好|进度|查一下|查询|衣服/.test(query) || /订单号|查订单|洗好了吗/.test(text))
            return '您好，麻烦您提供一下订单号，我帮您查询当前状态。';
        return NO_ANSWER_TEXT;
    }
    return text;
}
export async function generateCustomerServiceAnswer(input) {
    const provider = createLLMProvider();
    const evidence = input.cards.map((item, index) => `${index + 1}. ${item.card.title}\n${item.card.answer ?? item.card.content}`).join('\n\n');
    const prompt = [
        '你是客服助手，只能根据【知识库内容】回答。',
        '资料不足时只回复：当前资料里没有查到明确说明，建议帮您转人工确认一下。',
        '价格、退款、预约、营业时间、地址、套餐和停车必须严格按照资料回答，不得补充或猜测。',
        '回复简短自然，只输出适合直接发给客户的纯文本，不要暴露知识库、检索、模型等技术词。',
        '如果资料是内部操作说明（含“应先”“不得猜测”“内部约束”等），必须改写成面向顾客的短句，禁止原样复述。',
        `【用户问题】\n${input.query}`,
        `【知识库内容】\n${evidence}`
    ].join('\n\n');
    return sanitizeAnswer(await provider.chat({ platform: 'all', prompt }), input.query);
}
