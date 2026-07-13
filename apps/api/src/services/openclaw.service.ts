// @ts-nocheck
/**
 * @file apps/api/src/services/openclaw.service.ts
 * @module API Service 与 Worker
 * @description OpenClaw 回复生成、订单意图识别和纯文本清理。
 * @see 联动关注：ReplyWorker 与 Token 文件。
 */
import { env } from '../config/env.js';
import { z } from 'zod';
const orderActionSchema = z.object({
    action: z.enum(['query_order_by_no', 'query_orders_by_phone', 'handoff', 'none']),
    orderNo: z.string().optional(),
    phone: z.string().optional()
});
const domSelectorSchema = z.object({
    messageItemSelector: z.string().min(1).max(300),
    messageTextSelector: z.string().min(1).max(300),
    replyInputSelector: z.string().min(1).max(300),
    sendButtonSelector: z.string().min(1).max(300),
    sessionRootSelector: z.string().min(1).max(300),
    customerNameSelector: z.string().min(1).max(300),
    trackingAttribute: z.string().min(1).max(100)
});
function toCustomerPlainText(content) {
    // 平台聊天框通常不渲染 Markdown；发送前去掉常见格式符，避免客户看到星号、标题井号或链接语法。
    return String(content ?? '')
        .replace(/\*\*(.*?)\*\*/gs, '$1')
        .replace(/__(.*?)__/gs, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
        .trim();
}

/**
 * 拦截把「内部操作说明」当成客服话术发出去的情况。
 * 知识库里常有“应先…不得猜测…”这类给 AI 看的规则，模型偶发会原样复述。
 */
function looksLikeInternalInstruction(text) {
    const value = String(text ?? '');
    if (!value)
        return true;
    const patterns = [
        /顾客只说/,
        /应先礼貌/,
        /不得猜测/,
        /不得根据昵称/,
        /不得编造/,
        /客服不得/,
        /AI\s*不得/,
        /AI 客服不得/,
        /内部规则|操作说明|系统提示/,
        /只读订单查询 Adapter/,
        /不得向客户泄露/,
        /^答[:：]\s*请提供订单号/m
    ];
    // 同时出现多条“规则口吻”时，几乎肯定是内部说明而不是对客回复。
    const hitCount = patterns.filter((pattern) => pattern.test(value)).length;
    if (hitCount >= 1 && /不得|应先|顾客只说|Adapter|内部/.test(value))
        return true;
    if (/^#{1,6}\s*\d+(\.\d+)*/m.test(value))
        return true;
    return false;
}

function sanitizeCustomerReply(content, userMessage = '') {
    const plain = toCustomerPlainText(content);
    if (!plain)
        return '这个我帮您转人工确认一下。';
    if (looksLikeInternalInstruction(plain)) {
        // 订单进度类问题：把内部“先要订单号”规则改写成对客话术。
        if (/订单|洗好|进度|查一下|查询|衣服/.test(userMessage) || /订单号|查订单|洗好了吗/.test(plain))
            return '您好，麻烦您提供一下订单号，我帮您查询当前状态。';
        return '这个我帮您转人工确认一下。';
    }
    // 去掉偶发前缀“您好，### 9.x …”这类标题残留。
    return plain
        .replace(/^您好[，,]\s*(?:#{1,6}\s*)?\d+(\.\d+)*\s*[^\n]*\n+/u, '您好，')
        .replace(/^(?:#{1,6}\s*)?\d+(\.\d+)*\s*[^\n]*\n+/u, '')
        .trim() || '这个我帮您转人工确认一下。';
}
export class OpenClawClient {
    /**
     * OpenClaw 只分析扩展生成的脱敏 DOM 结构；模型结果必须回到真实页面验证后才能保存。
     */
    async analyzeDomSelectors(snapshot) {
        if (this.shouldUseLocalFallback())
            return null;
        const content = await this.requestText([
            {
                role: 'system',
                content: [
                    '你是浏览器 DOM 选择器分析器，只输出 JSON，不要输出 Markdown。',
                    '输入是已脱敏的客服聊天页面结构，不含聊天正文、手机号、Cookie 或图片地址。',
                    '客户消息选择器必须排除 right-message 和 shop-text，只命中 left-message。',
                    '优先使用稳定 class、data 属性和 contenteditable；禁止 nth-child、动态哈希 class 和文本选择器。',
                    'sessionRootSelector 必须定位带用户和门店埋点属性的客户信息根节点。',
                    '格式：{"messageItemSelector":"","messageTextSelector":"","replyInputSelector":"","sendButtonSelector":"","sessionRootSelector":"","customerNameSelector":"","trackingAttribute":""}'
                ].join('\n')
            },
            { role: 'user', content: JSON.stringify(snapshot) }
        ], 8000);
        if (!content)
            return null;
        try {
            const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
            return domSelectorSchema.parse(JSON.parse(jsonText));
        }
        catch {
            return null;
        }
    }
    /**
     * 让 OpenClaw 只做意图判断，不允许模型直接访问接口或生成任意工具参数。
     * 后端还会再次校验返回值，并且只执行枚举中的白名单动作。
     */
    async analyzeOrderAction(message) {
        const localAction = this.analyzeOrderActionLocally(message);
        if (this.shouldUseLocalFallback())
            return localAction;
        const content = await this.requestText([
            {
                role: 'system',
                content: [
                    '你是客服系统的只读订单工具路由器，只输出 JSON，不要输出 Markdown。',
                    '允许的 action 只有 query_order_by_no、query_orders_by_phone、handoff、none。',
                    '客户要求查询、查看、再查某个像订单号的字母数字串时，选择 query_order_by_no。',
                    '客户要求按手机号查订单时，选择 query_orders_by_phone。',
                    '退款、投诉、差评、赔偿、食品安全、法律或威胁类问题选择 handoff。',
                    '不得创造客户没有提供的订单号或手机号。',
                    '格式：{"action":"none","orderNo":"","phone":""}'
                ].join('\n')
            },
            { role: 'user', content: message }
        ]);
        if (!content)
            return localAction;
        try {
            const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
            const parsed = orderActionSchema.parse(JSON.parse(jsonText));
            // 模型只能选择动作，参数必须确实出现在客户原文里，防止模型补写或猜测订单号。
            if (parsed.action === 'query_order_by_no') {
                if (!parsed.orderNo || !message.toLowerCase().includes(parsed.orderNo.toLowerCase()))
                    return localAction;
            }
            if (parsed.action === 'query_orders_by_phone') {
                if (!parsed.phone || !message.includes(parsed.phone))
                    return localAction;
            }
            return parsed;
        }
        catch {
            return localAction;
        }
    }
    /**
     * OpenClaw 仅负责把已经脱敏的真实查询结果组织成客服话术。
     * 模型不可用时返回 null，由订单服务使用确定性模板兜底。
     */
    async generateOrderReply(message, safeOrderContext) {
        if (this.shouldUseLocalFallback())
            return null;
        return this.requestText([
            {
                role: 'system',
                content: [
                    '你是门店客服助手，只能根据公司订单系统的只读查询结果回答。',
                    '不得猜测、补全或修改订单数据，不得承诺退款或赔偿。',
                    '不得输出鉴权信息、内部字段、完整手机号或查询过程。',
                    '查询结果没有某项信息时不要编造；回复简洁、礼貌。',
                    '如果客户要求具体或完整信息，请逐项覆盖查询结果中所有不是“未知”或“已脱敏”的字段，不要擅自省略。'
                ].join('\n')
            },
            {
                role: 'user',
                content: `客户问题：${message}\n\n公司订单系统查询结果：\n${safeOrderContext}`
            }
        ]);
    }
    // 统一封装 OpenClaw 调用，避免业务代码到处拼接口。
    async generateReply(input) {
        if (this.shouldUseLocalFallback()) {
            return this.generateLocalFallback(input, 'OpenClaw 未配置，使用本地兜底草稿');
        }
        const endpoint = env.OPENCLAW_CHAT_ENDPOINT.replace('{agentId}', env.OPENCLAW_AGENT_ID);
        const url = `${env.OPENCLAW_GATEWAY_URL}${endpoint}`;
        const systemRules = [
            '你是门店团购客服助手。',
            '你只能根据知识库内容和门店规则回答。',
            '涉及订单时，只能根据“公司订单系统查询结果”回答，不得猜测订单状态、金额或核销状态。',
            '不得向客户泄露接口原始数据、鉴权信息或未脱敏的客户隐私。',
            '如果知识库没有明确答案，回复：这个我帮您转人工确认一下。',
            '不要承诺退款、赔偿、免费赠送、特殊折扣。',
            '遇到投诉、差评、退款、食品安全、法律纠纷，必须转人工。',
            '回复要简洁、礼貌、像真人客服。',
            '只输出纯文本，不要使用 Markdown 标题、粗体、列表或链接语法。',
            '如果知识库内容是内部操作说明（含“应先”“不得猜测”“顾客只说”等），必须改写成面向顾客的短句，禁止原样复述规则文本。'
        ].join('\n');
        const userContent = [
            `客户问题：${input.message}`,
            '',
            '知识库命中内容：',
            input.ragContext.length > 0
                ? input.ragContext.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
                : '无',
            '',
            '请只根据上面的知识库内容，直接回复客户可见的话术。'
        ].join('\n');
        // OpenClaw 本地网关当前暴露的是 OpenAI 兼容的 chat_completions 接口。
        // 这里把 RAG 结果塞进用户消息，确保模型不会绕过知识库自由发挥。
        // 即使模型本身能力很强，也必须被限制在知识库上下文里，避免客服场景胡编门店规则。
        const payload = {
            model: env.OPENCLAW_MODEL,
            user: input.conversationHistory.at(-1)?.content,
            messages: [
                {
                    role: 'system',
                    content: systemRules
                },
                ...input.conversationHistory,
                {
                    role: 'user',
                    content: userContent
                }
            ]
        };
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                signal: AbortSignal.timeout(env.OPENCLAW_TIMEOUT_MS),
                headers: {
                    Authorization: `Bearer ${env.OPENCLAW_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
        }
        catch (error) {
            return this.generateLocalFallback(input, `OpenClaw 请求异常：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!res.ok) {
            const body = await res.text();
            return this.generateLocalFallback(input, `OpenClaw 请求失败：${res.status} ${body}`);
        }
        const raw = await res.json();
        // 不同 OpenClaw / LLM 服务返回格式可能不同，这里做宽松兼容。
        // 兼容层集中在这里，避免 ReplyWorker 关心具体模型网关的响应细节。
        const generatedContent = raw.choices?.[0]?.message?.content?.trim()
                ?? raw.output_text?.trim()
                ?? raw.result?.text?.trim()
                ?? raw.content
                ?? raw.reply
                ?? raw.message
                ?? '这个我帮您转人工确认一下。';
        return {
            content: sanitizeCustomerReply(generatedContent, input.message),
            confidence: raw.confidence ?? 0.7,
            raw
        };
    }
    shouldUseLocalFallback() {
        // demo 默认 token 是占位值，不能真的请求模型网关；这里直接走本地兜底，避免本地调试时刷 404。
        return !env.OPENCLAW_TOKEN
            || env.OPENCLAW_TOKEN === 'replace-me'
            || env.OPENCLAW_TOKEN === 'your_openclaw_token';
    }
    analyzeOrderActionLocally(message) {
        const highRiskKeywords = ['退款', '投诉', '差评', '赔偿', '食品安全', '吃坏', '过敏', '报警', '12315', '工商', '法律', '律师', '威胁'];
        if (highRiskKeywords.some((keyword) => message.includes(keyword)))
            return { action: 'handoff' };
        const phone = message.match(/1[3-9]\d{9}/)?.[0];
        const hasQueryIntent = ['查', '查询', '看看', '看下', '状态', '进度', '订单'].some((keyword) => message.includes(keyword));
        if (phone && hasQueryIntent)
            return { action: 'query_orders_by_phone', phone };
        const candidates = message.match(/[A-Za-z0-9_-]{6,64}/g) ?? [];
        const orderNo = candidates.find((candidate) => /[A-Za-z]/.test(candidate) && /\d/.test(candidate));
        if (orderNo && hasQueryIntent)
            return { action: 'query_order_by_no', orderNo };
        if (hasQueryIntent && ['订单', '查单'].some((keyword) => message.includes(keyword))) {
            return { action: 'query_order_by_no' };
        }
        return { action: 'none' };
    }
    async requestText(messages, timeoutMs = env.OPENCLAW_TIMEOUT_MS) {
        const endpoint = env.OPENCLAW_CHAT_ENDPOINT.replace('{agentId}', env.OPENCLAW_AGENT_ID);
        const url = `${env.OPENCLAW_GATEWAY_URL}${endpoint}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                // 工具路由不能被模型网关长期阻塞；超时后会使用本地确定性规则继续处理。
                signal: AbortSignal.timeout(timeoutMs),
                headers: {
                    Authorization: `Bearer ${env.OPENCLAW_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model: env.OPENCLAW_MODEL, messages })
            });
            if (!response.ok)
                return null;
            const raw = await response.json();
            const content = raw.choices?.[0]?.message?.content
                ?? raw.output_text
                ?? raw.result?.text
                ?? raw.content
                ?? raw.reply
                ?? raw.message;
            return typeof content === 'string' ? content.trim() : null;
        }
        catch {
            return null;
        }
    }
    generateLocalFallback(input, reason) {
        const firstContext = input.ragContext[0]?.content.trim();
        // 旧 apps/api worker 仍然服务于 demo 草稿流；外部模型不可用时，必须坚持“无知识库不回答”。
        // 有命中内容时只截取知识库原文生成建议草稿，避免兜底逻辑编造退款、赔偿等高风险承诺。
        // 但必须经 sanitize：内部操作说明（“应先/不得猜测”）不能原样发给客户。
        const drafted = firstContext
            ? `您好，${firstContext.slice(0, 180)}`
            : '这个我帮您转人工确认一下。';
        return {
            content: sanitizeCustomerReply(drafted, input.message),
            confidence: firstContext ? 0.55 : 0,
            raw: {
                provider: 'local-fallback',
                reason
            }
        };
    }
}
