// @ts-nocheck
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
const defaultConfig = {
    lowConfidenceThreshold: env.RAG_SCORE_THRESHOLD,
    hardRejectThreshold: env.RAG_HARD_FLOOR,
    maxContinuousAiReplies: 5,
    sensitiveKeywords: ['退款', '投诉', '差评', '赔偿', '食品安全', '吃坏', '过敏', '报警', '12315', '工商', '法律', '律师', '人工', '客服', '老板', '电话'],
    fallbackReply: '这个问题我需要帮您转人工确认一下，请稍等。'
};
export async function loadHandoffConfig() {
    // 风控规则使用 UTF-8 外部配置，业务可调整阈值，但代码中的安全默认值始终作为兜底。
    try {
        const text = await readFile(resolve(process.cwd(), '../../config/handoff-rules.json'), 'utf-8');
        return { ...defaultConfig, ...JSON.parse(text) };
    }
    catch {
        return defaultConfig;
    }
}
export class HandoffService {
    config;
    constructor(config) {
        this.config = config;
    }
    checkBeforeRetrieval(userMessage, aiReplyCount) {
        // 高风险关键词在检索和模型调用前拦截，避免模型生成退款、赔偿等越权承诺。
        const keyword = this.config.sensitiveKeywords.find((item) => userMessage.includes(item));
        if (keyword)
            return this.needHuman(`命中敏感词：${keyword}`);
        if (aiReplyCount >= this.config.maxContinuousAiReplies)
            return this.needHuman('连续 AI 回复次数过多');
        return { needHuman: false, reason: '', fallbackReply: this.config.fallbackReply };
    }
    checkAfterRetrieval(results) {
        // 硬拒绝线只过滤明显无关结果；中间分数交给模型做证据审查，不能把相似度当正确率。
        if (!results.length)
            return this.needHuman('知识库没有召回内容');
        const topScore = results[0]?.score ?? 0;
        if (topScore < this.config.hardRejectThreshold)
            return this.needHuman('知识库召回结果低于硬拒绝线');
        if (this.hasConflict(results))
            return this.needHuman('知识库命中内容可能存在冲突');
        return {
            needHuman: false,
            reason: '',
            fallbackReply: this.config.fallbackReply,
            requiresEvidenceReview: topScore < this.config.lowConfidenceThreshold
        };
    }
    needHuman(reason) {
        return { needHuman: true, reason, fallbackReply: this.config.fallbackReply };
    }
    hasConflict(results) {
        // 只检查分数接近的头部片段，防止知识库存在相反规则时模型自行选择有利答案。
        const close = results.slice(0, 3);
        if (close.length < 2 || Math.abs((close[0]?.score ?? 0) - (close[1]?.score ?? 0)) >= 0.03)
            return false;
        // “周末可用，法定节假日除外”这类同一条规则里同时有允许和限制，不是冲突。
        // 只有不同 chunk 分别给出明确相反结论时，才转人工确认。
        const positiveOnly = close.some((item) => /可以|支持|允许|可用|都可用/.test(item.content) && !/不可以|不支持|禁止|不能|不可用/.test(item.content));
        const negativeOnly = close.some((item) => /不可以|不支持|禁止|不能|不可用/.test(item.content) && !/可以|支持|允许|可用|都可用/.test(item.content));
        return positiveOnly && negativeOnly;
    }
}
