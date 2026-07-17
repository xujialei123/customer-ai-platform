// @ts-nocheck
/**
 * @file apps/api/src/services/safety.service.ts
 * @module API Service 与 Worker
 * @description 高风险词、非寒暄空召回转人工、禁止承诺和自动发送开关判定。
 * @see 联动关注：AGENTS.md 风控规则、handoff。
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
    // 短促笑声/语气词：客户常用来试探在不在，知识库天然召不回，不应卡成 medium 仅回填。
    if (/^(嘻嘻|哈哈|呵呵|嘿嘿|啦啦|哟|呀|哦|噢|嗯呢|在呢)[呀啊呵哈～~!！。.]*$/i.test(text))
        return true;
    // 「x嘻嘻」这类：抽中文核心再判一次寒暄。
    const chineseCore = text.replace(/[^\u4e00-\u9fff]/g, '');
    if (chineseCore
        && chineseCore.length <= 8
        && /^(你好|您好|在吗|嘻嘻|哈哈|呵呵|嘿嘿|谢谢|好的|嗯嗯|收到|明白)$/.test(chineseCore))
        return true;
    return false;
}

/** 会话渠道中文名：写进提示词，避免模型再问「美团还是抖音」。 */
export function platformChannelLabel(platform) {
    const raw = String(platform || '').toLowerCase();
    if (raw === 'douyin')
        return '抖音来客（抖音生活服务）';
    if (raw === 'meituan')
        return '美团经营宝（美团到店团购）';
    if (raw === 'wecom')
        return '企业微信客服';
    return '';
}

/**
 * 美团/抖音经营端常拦截「微信/QQ」等站外导流词，提交会失败。
 * 出稿前改成「本对话」表述；并去掉「您是在美团还是抖音买的」这类跨平台追问。
 */
export function sanitizePlatformOutboundText(content, platform) {
    let text = String(content ?? '');
    if (!text)
        return text;
    text = text
        .replace(/随时\s*(用)?\s*(微信|威信|vx|v信)\s*(跟|和)?\s*我说/gi, '随时在本对话跟我说')
        .replace(/加\s*(我|个|一下)?\s*(的)?\s*(微信|威信|vx|v信|微信号)/gi, '在本对话联系我')
        .replace(/(微信|威信|vx|v信)\s*(号|联系)/gi, '本对话联系')
        .replace(/微信号|威信号/g, '联系方式')
        .replace(/微信|威信|v信/gi, '本对话')
        .replace(/\b(wechat)\b/gi, '本对话')
        .replace(/\bvx\b/gi, '本对话')
        .replace(/扣扣\s*号?|\bqq\b/gi, '本对话')
        .replace(/本对话本对话/g, '本对话')
        .replace(/本对话\s*本对话/g, '本对话');

    const channel = String(platform || '').toLowerCase();
    // 客户已在某一端进线：再问「美团还是抖音」既多余，也容易被平台风控标红/拒发。
    if (channel === 'douyin' || channel === 'meituan' || channel === 'wecom') {
        text = text
            .replace(/[，,]?\s*方便告诉我您是在美团还是抖音买的吗[？?]?\s*/g, '。方便的话把订单号或订单截图发在本对话，我帮您查。')
            .replace(/[，,]?\s*您是在美团还是抖音(上|买的)?吗[？?]?\s*/g, '。')
            .replace(/[，,]?\s*(是在)?美团还是抖音[？?]?\s*/g, '。')
            .replace(/[，,]?\s*您是在抖音还是美团(上|买的)?吗[？?]?\s*/g, '。')
            .replace(/[，,]?\s*(是在)?抖音还是美团[？?]?\s*/g, '。');
    }
    if (channel === 'douyin') {
        // 抖音会话里不要主动把客户往美团导；不整词抹掉「美团」，避免误伤正常说明。
        text = text.replace(/[，,]?\s*去美团(看看|买|下单|咨询)?[。！!]?\s*/g, '。');
    }
    if (channel === 'meituan') {
        text = text.replace(/[，,]?\s*去抖音(看看|买|下单|咨询)?[。！!]?\s*/g, '。');
    }

    return text
        .replace(/。{2,}/g, '。')
        .replace(/^[。，,\s]+/, '')
        .trim();
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
        // 非寒暄空召回：无知识依据不得自动发送，进转人工（AGENTS：无明确答案须转人工确认）。
        if ((input.ragHitCount ?? 0) === 0) {
            return {
                allowAutoSend: false,
                riskLevel: 'high',
                reason: '知识库未召回，需转人工确认'
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
