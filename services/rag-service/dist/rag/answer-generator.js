import { createLLMProvider } from '../providers/llm.js';
import { NO_ANSWER_TEXT } from './fallback.js';
function sanitizeAnswer(answer) {
    const text = answer.trim().replace(/\*\*(.*?)\*\*/gs, '$1').replace(/^#{1,6}\s+/gm, '');
    if (!text || /(知识库|RAG|检索结果|模型)/i.test(text))
        return NO_ANSWER_TEXT;
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
        `【用户问题】\n${input.query}`,
        `【知识库内容】\n${evidence}`
    ].join('\n\n');
    return sanitizeAnswer(await provider.chat({ platform: 'all', prompt }));
}
