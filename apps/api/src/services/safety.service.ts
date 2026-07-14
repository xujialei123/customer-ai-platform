// @ts-nocheck
/**
 * @file apps/api/src/services/safety.service.ts
 * @module API Service 与 Worker
 * @description 高风险词、禁止承诺和自动发送开关判定。
 * @see 联动关注：AGENTS.md 风控规则。
 */

/** 寒暄/礼貌短句：无知识召回也不必转人工，交给模型正常应答。 */
export function isCasualCustomerMessage(message) {
    const text = String(message ?? '').replace(/\s+/g, '').trim();
    if (!text || text.length > 24)
        return false;
    if (/^(你好|您好|在吗|在不在|嗨|哈喽|hello|hi|hey)[呀啊呵哈吗嘛～~!！。.]*$/i.test(text))
        return true;
    if (/^(谢谢|谢谢您|多谢|感谢|好的|嗯嗯|嗯|ok|okay|收到|明白|了解|知道了|好哒|拜拜|再见)[呀啊呵哈～~!！。.]*$/i.test(text))
        return true;
    return false;
}

export class SafetyService {
    // 仅保留明确售后/合规风险；去掉「能退」「想退」「法律」等过宽子串，避免正常咨询误伤。
    highRiskKeywords = [
        '退款',
        '退券',
        '退钱',
        '投诉',
        '差评',
        '赔偿',
        '食品安全',
        '吃坏',
        '过敏',
        '报警',
        '12315',
        '工商',
        '律师'
    ];
    // 需整句语境才升为高风险，避免「能不能改期」误命中「能退」。
    highRiskPatterns = [
        /想退款|要退款|申请退款|给我退|能退款|可以退款/,
        /打官司|走法律|找律师/
    ];
    forbiddenCommitments = [
        '给您退款',
        '赔偿您',
        '免费赠送',
        '特殊折扣',
        '私下交易'
    ];
    // 风控既检查客户问题，也检查 AI 回复。
    // 客户问题高风险时不自动回复；AI 回复包含违规承诺时也不自动发送。
    checkRisk(input) {
        const userMessage = String(input.userMessage ?? '');
        if (this.highRiskKeywords.some((kw) => userMessage.includes(kw))
            || this.highRiskPatterns.some((pattern) => pattern.test(userMessage))) {
            return {
                allowAutoSend: false,
                riskLevel: 'high',
                reason: '命中高风险关键词，需要转人工'
            };
        }
        // 寒暄无召回：允许低风险自动路径，避免「你好」也进转人工台。
        if ((input.ragHitCount ?? 0) === 0 && isCasualCustomerMessage(userMessage)) {
            return {
                allowAutoSend: true,
                riskLevel: 'low'
            };
        }
        if ((input.ragHitCount ?? 0) === 0) {
            return {
                allowAutoSend: false,
                riskLevel: 'medium',
                reason: '知识库未召回内容，建议人工确认或先澄清客户需求'
            };
        }
        if (input.aiReply && this.forbiddenCommitments.some((kw) => input.aiReply.includes(kw))) {
            return {
                allowAutoSend: false,
                riskLevel: 'high',
                reason: 'AI 回复包含禁止承诺，需要人工审核'
            };
        }
        return {
            allowAutoSend: true,
            riskLevel: 'low'
        };
    }
}
