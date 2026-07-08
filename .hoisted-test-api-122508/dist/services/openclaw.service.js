// @ts-nocheck
import { env } from '../config/env.js';
import { z } from 'zod';
const orderActionSchema = z.object({
    action: z.enum(['query_order_by_no', 'query_orders_by_phone', 'handoff', 'none']),
    orderNo: z.string().optional(),
    phone: z.string().optional()
});
export class OpenClawClient {
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
            '回复要简洁、礼貌、像真人客服。'
        ].join('\n');
        const userContent = [
            `客户问题：${input.message}`,
            '',
            '知识库命中内容：',
            input.ragContext.length > 0
                ? input.ragContext.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
                : '无',
            '',
            '请只根据上面的知识库内容回复客户。'
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
        return {
            content: raw.choices?.[0]?.message?.content?.trim()
                ?? raw.output_text?.trim()
                ?? raw.result?.text?.trim()
                ?? raw.content
                ?? raw.reply
                ?? raw.message
                ?? '这个我帮您转人工确认一下。',
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
    async requestText(messages) {
        const endpoint = env.OPENCLAW_CHAT_ENDPOINT.replace('{agentId}', env.OPENCLAW_AGENT_ID);
        const url = `${env.OPENCLAW_GATEWAY_URL}${endpoint}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                // 工具路由不能被模型网关长期阻塞；超时后会使用本地确定性规则继续处理。
                signal: AbortSignal.timeout(env.OPENCLAW_TIMEOUT_MS),
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
        return {
            content: firstContext
                ? `您好，${firstContext.slice(0, 180)}`
                : '这个我帮您转人工确认一下。',
            confidence: firstContext ? 0.55 : 0,
            raw: {
                provider: 'local-fallback',
                reason
            }
        };
    }
}
