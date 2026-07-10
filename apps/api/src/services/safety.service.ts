// @ts-nocheck
/**
 * @file apps/api/src/services/safety.service.ts
 * @module API Service 与 Worker
 * @description 高风险词、禁止承诺和自动发送开关判定。
 * @see 联动关注：AGENTS.md 风控规则。
 */
export class SafetyService {
    highRiskKeywords = [
        '退款',
        '退券',
        '退钱',
        '能退',
        '想退',
        '投诉',
        '差评',
        '赔偿',
        '食品安全',
        '吃坏',
        '过敏',
        '报警',
        '12315',
        '工商',
        '法律',
        '律师'
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
        if (this.highRiskKeywords.some((kw) => input.userMessage.includes(kw))) {
            return {
                allowAutoSend: false,
                riskLevel: 'high',
                reason: '命中高风险关键词，需要转人工'
            };
        }
        if ((input.ragHitCount ?? 0) === 0) {
            return {
                allowAutoSend: false,
                riskLevel: 'medium',
                reason: '知识库未召回内容，需要转人工确认'
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
