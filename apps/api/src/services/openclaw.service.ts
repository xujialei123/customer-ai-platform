// @ts-nocheck
/**
 * @file apps/api/src/services/openclaw.service.ts
 * @module API Service 与 Worker
 * @description LLM 回复生成（读 model-config：Agnes / 自定义 OpenAI 兼容；可选 OpenClaw）。
 * @see 联动关注：ReplyWorker、model-config、订单脱敏结果。
 */
import { env } from '../config/env.js';
import { getActiveLlmTarget } from '../config/model-config.js';
import { isCasualCustomerMessage } from './safety.service.js';
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
    // 至少两条规则口吻才视为内部说明，避免正常话术里偶发「不得」被误杀成转人工。
    const hitCount = patterns.filter((pattern) => pattern.test(value)).length;
    if (hitCount >= 2 && /不得|应先|顾客只说|Adapter|内部/.test(value))
        return true;
    if (/^#{1,6}\s*\d+(\.\d+)*/m.test(value))
        return true;
    return false;
}

/** 去掉客服复读机开场（好的/明白/收到），模型常因提示词或历史轮次连环复读。 */
function stripRoteOpeners(text) {
    const original = String(text ?? '').trim();
    if (!original)
        return original;
    let value = original;
    for (let i = 0; i < 3; i += 1) {
        const next = value
            .replace(/^(好的[呀啊呵哈]*)?[，,。.\s]*(明白的?)[，,。.\s]+/u, '')
            .replace(/^(明白的?)[，,。.\s]+/u, '')
            .replace(/^(好的[呀啊呵哈]*)[，,。.\s]+/u, '')
            .replace(/^(收到|了解|清楚了)[，,。.\s]+/u, '')
            .trim();
        if (next === value)
            break;
        value = next;
    }
    return value || original;
}

/**
 * 已有实质答复时，删掉句尾复读的「转人工/跟门店确认」，避免「答了半句又推锅」。
 */
function stripRedundantHandoffTail(text, hasRagEvidence) {
    if (!hasRagEvidence)
        return text;
    const without = String(text ?? '')
        .replace(/[。！？]?\s*(这个我帮您转人工确认一下。?|我马上帮您跟门店确认[^。！？]*[。！？]?)\s*$/u, '')
        .trim();
    return without.length >= 12 ? without : text;
}

/** 把知识库「问/答」原文改成可对客短句；去掉标题与「问：」「答：」标签。 */
function rewriteKbSnippetForCustomer(raw) {
    let text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text)
        return '';
    const answerMatch = text.match(/答[：:]\s*(.+)$/u);
    if (answerMatch)
        text = answerMatch[1].trim();
    text = text
        .replace(/#{1,6}\s*/g, '')
        .replace(/(?:^|[。；;\s])问[：:]\s*[^答]{0,80}(?=答[：:]|$)/u, '')
        .replace(/问[：:]\s*/g, '')
        .replace(/答[：:]\s*/g, '')
        .replace(/^您好[，,]\s*/u, '')
        .trim();
    return text.slice(0, 180);
}

/**
 * 粗筛：检索片段是否像在答当前客户问题。
 * 避免「套餐都有哪些」却命中「团购券可以叠加」后，兜底把无关 FAQ 原文发出去。
 */
function isRagSnippetRelevant(query, snippet) {
    const q = String(query ?? '').replace(/\s+/g, '');
    const raw = String(snippet ?? '').replace(/\s+/g, ' ');
    if (!q || !raw)
        return false;
    if (/公司订单系统查询结果/.test(raw))
        return true;
    const faqQ = raw.match(/(?:###\s*)?问[：:]\s*([^\n答]+)/u)?.[1]?.replace(/\s+/g, '') || '';
    const answer = (raw.match(/答[：:]\s*([\s\S]+)/u)?.[1] || raw).replace(/\s+/g, '');
    const corpus = `${faqQ}${answer}`;
    // 意图错配：客户要套餐清单，片段却只讲叠加/核销规则。
    if (/都有哪些|有哪些套餐|套餐有什么|哪些套餐|有什么套餐/.test(q)
        && /叠加|核销一次|是否可以叠加/.test(corpus)
        && !/(价目|报价|单价|套餐列表|包含项目|参考价)/.test(corpus))
        return false;
    const stop = new Set(['可以', '什么', '怎么', '如何', '请问', '一下', '这个', '那个', '门店', '客户', '需要', '还是']);
    const qWords = [...q.matchAll(/[\u4e00-\u9fff]{2,}/gu)]
        .map((item) => item[0])
        .filter((word) => !stop.has(word));
    if (qWords.length === 0)
        return true;
    const hits = qWords.filter((word) => corpus.includes(word));
    // 「套餐」这类泛词命中一次不够；至少命中 2 个实词，或命中非泛词的关键实词。
    const weak = new Set(['套餐', '团购', '订单', '衣服', '洗护']);
    const strongHits = hits.filter((word) => !weak.has(word));
    if (strongHits.length >= 1)
        return true;
    if (hits.length >= 2)
        return true;
    return false;
}

function pickRelevantRagSnippet(query, ragContext) {
    const list = Array.isArray(ragContext) ? ragContext : [];
    for (const item of list) {
        const content = String(item?.content ?? '').trim();
        if (content && isRagSnippetRelevant(query, content))
            return content;
    }
    return '';
}

function sanitizeCustomerReply(content, userMessage = '', options = {}) {
    let plain = stripRoteOpeners(toCustomerPlainText(content));
    if (!plain)
        return '这个我帮您转人工确认一下。';
    // 拦住把 FAQ「问：/答：」模板原文发给客户的情况。
    if (/问[：:]/.test(plain) || /答[：:]/.test(plain) || /#{1,6}/.test(content || '')) {
        const rewritten = rewriteKbSnippetForCustomer(plain);
        if (rewritten && isRagSnippetRelevant(userMessage, plain))
            plain = rewritten;
        else if (!isRagSnippetRelevant(userMessage, plain))
            return '这个问题我帮您再核对一下具体条款，您方便说下想了解套餐清单、价格，还是某个已买套餐的规则？';
        else
            plain = rewritten || plain;
    }
    if (looksLikeInternalInstruction(plain)) {
        // 订单进度类问题：把内部“先要订单号”规则改写成对客话术。
        if (/订单|洗好|进度|查一下|查询|衣服/.test(userMessage) || /订单号|查订单|洗好了吗/.test(plain))
            return '麻烦您提供一下订单号，我帮您查下当前状态。';
        return '这个我帮您转人工确认一下。';
    }
    const cleaned = plain
        .replace(/^您好[，,]\s*(?:#{1,6}\s*)?\d+(\.\d+)*\s*[^\n]*\n+/u, '')
        .replace(/^(?:#{1,6}\s*)?\d+(\.\d+)*\s*[^\n]*\n+/u, '')
        .replace(/#{1,6}\s*/g, '')
        .trim() || '这个我帮您转人工确认一下。';
    return stripRedundantHandoffTail(cleaned, Boolean(options.hasRagEvidence));
}
export class OpenClawClient {
    /**
     * OpenClaw 只分析扩展生成的脱敏 DOM 结构；模型结果必须回到真实页面验证后才能保存。
     */
    async analyzeDomSelectors(snapshot) {
        if (await this.shouldUseLocalFallback())
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
        if (await this.shouldUseLocalFallback())
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
        if (await this.shouldUseLocalFallback())
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
    // 统一封装 chat completions 调用（默认直连 Agnes；openclaw 仅作可选本机网关）。
    async generateReply(input) {
        if (await this.shouldUseLocalFallback()) {
            const target = await getActiveLlmTarget();
            return this.generateLocalFallback(input, `LLM 未配置（provider=${target.provider}），使用本地兜底草稿`);
        }
        const llm = await getActiveLlmTarget();
        const hasRag = Array.isArray(input.ragContext) && input.ragContext.length > 0;
        const hasOrderResult = (input.ragContext ?? []).some((item) => /公司订单系统查询结果/.test(String(item?.content ?? ''))
            || item?.metadata?.source === 'company-order-system');
        const casual = isCasualCustomerMessage(input.message);
        const systemRules = [
            '你是门店团购的真人客服，正在微信式即时聊天。',
            '优先 1～2 句；开门见山答客户刚问的点，不要先客套再绕弯。',
            '严禁用这些开场（每条回复都不许出现在开头）：好的、明白、明白的、好的明白、收到、了解。直接从答案说起。',
            '不要每句都说“跟门店确认 / 转人工”；资料够就直接答完，资料不够再问一句关键细节，只有完全答不了才用转人工句。',
            '事实题必须依据门店资料；有相关条款就归纳成口语，不要复述内部规则原文。',
            '严禁输出「问：」「答：」「###」或把知识库条目原样粘贴给客户；必须用口语复述能直接回答客户本轮问题的内容。',
            '如果资料与客户问题明显不符（例如客户问套餐清单，资料却在讲叠加规则），不要硬套资料，先追问客户具体想了解哪一类，或说明需要再确认。',
            '寒暄、致谢：简短自然接话，不要提转人工，也不要提知识库/模型/检索。',
            '不要承诺退款、赔偿、免费赠送、特殊折扣；去渍等效果类问题用“尽力处理、不保证百分之百”这类已有规则表述，不要另加转人工。',
            '若资料里有「公司订单系统查询结果」：必须把其中非“未知/已脱敏”的字段用口语逐项告诉客户（订单号、状态、商品、金额、门店等），禁止只说“已调取/以系统为准”却不报具体信息；查不到才如实说未查到。',
            '不得泄露接口数据、隐私和“知识库/RAG/模型”等内部说法。',
            '只输出纯文本，不要 Markdown、编号列表。'
        ].join('\n');
        // RAG + 多轮历史一起进模型；摘要单独贴在本轮 user 里，避免被 history 截断丢掉。
        const history = Array.isArray(input.conversationHistory)
            ? input.conversationHistory.filter((item) => item?.role === 'user' || item?.role === 'assistant')
            : [];
        const lastAssistant = [...history].reverse().find((item) => item.role === 'assistant');
        const lastUsedRoteOpener = Boolean(lastAssistant
            && /^(好的|明白|收到|了解)/.test(String(lastAssistant.content || '').trim()));
        const summaryBlock = input.conversationSummary
            ? `会话前情摘要（仅供参考，订单状态以本次查询为准）：\n${input.conversationSummary}\n\n`
            : '';
        const userContent = [
            summaryBlock + `客户本轮说：${input.message}`,
            '',
            hasRag
                ? `可参考的门店/订单资料：\n${input.ragContext.map((item, index) => `${index + 1}. ${item.content}`).join('\n')}`
                : (casual
                    ? '本轮是寒暄/礼貌用语；简短接话即可。'
                    : '门店资料未命中明确条款；用一句话问清关键细节，不要堆“明白+转人工”。'),
            '',
            hasOrderResult
                ? '本轮已有订单系统真实查询结果，请直接报出具体字段给客户，不要空泛推诿。'
                : (lastUsedRoteOpener
                    ? '上一句客服已用过“好的/明白”类开场，本轮严禁再这样开头，换说法直接答。'
                    : '本轮禁止“好的/明白”开头。'),
            '请写一条可直接发送的短回复。'
        ].join('\n');
        const payload = {
            model: llm.model,
            messages: [
                {
                    role: 'system',
                    content: systemRules
                },
                ...history,
                {
                    role: 'user',
                    content: userContent
                }
            ]
        };
        let res;
        try {
            res = await fetch(llm.chatUrl, {
                method: 'POST',
                signal: AbortSignal.timeout(env.OPENCLAW_TIMEOUT_MS),
                headers: {
                    Authorization: `Bearer ${llm.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
        }
        catch (error) {
            // 超时/网络失败也必须产出对客话术：不能卡死无回复。
            return this.generateLocalFallback(input, `LLM 请求异常：${error instanceof Error ? error.message : String(error)}`, {
                timedOut: isTimeoutError(error)
            });
        }
        if (!res.ok) {
            const body = await res.text();
            return this.generateLocalFallback(input, `LLM 请求失败：${res.status} ${body}`);
        }
        const raw = await res.json();
        // 兼容层集中在这里，避免 ReplyWorker 关心具体模型厂商的响应细节。
        const generatedContent = raw.choices?.[0]?.message?.content?.trim()
                ?? raw.output_text?.trim()
                ?? raw.result?.text?.trim()
                ?? raw.content
                ?? raw.reply
                ?? raw.message
                ?? '';
        // Agnes 偶发 content 为空只给 reasoning；不对客输出思考过程，走本地兜底话术。
        const safeContent = String(generatedContent || '').trim();
        if (!safeContent) {
            return this.generateLocalFallback(input, 'LLM 返回空内容', { emptyModelOutput: true });
        }
        return {
            content: sanitizeCustomerReply(safeContent, input.message, { hasRagEvidence: hasRag }),
            confidence: raw.confidence ?? 0.7,
            raw: { ...raw, provider: llm.provider }
        };
    }
    async shouldUseLocalFallback() {
        const llm = await getActiveLlmTarget();
        return !llm.configured;
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
        if (await this.shouldUseLocalFallback())
            return null;
        try {
            const llm = await getActiveLlmTarget();
            const response = await fetch(llm.chatUrl, {
                method: 'POST',
                // 工具路由不能被模型网关长期阻塞；超时后会使用本地确定性规则继续处理。
                signal: AbortSignal.timeout(timeoutMs),
                headers: {
                    Authorization: `Bearer ${llm.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ model: llm.model, messages })
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
    /**
     * 模型超时/失败时的对客兜底：必须有非空正文。
     * 有资料则用短摘；寒暄用人话应答；其余再转人工，避免句句模板。
     */
    generateLocalFallback(input, reason, options = {}) {
        const message = String(input.message ?? '');
        const relevantRaw = pickRelevantRagSnippet(message, input.ragContext);
        const rewritten = relevantRaw ? rewriteKbSnippetForCustomer(relevantRaw) : '';
        const timedOut = Boolean(options.timedOut);
        let drafted;
        if (rewritten) {
            drafted = timedOut
                ? `${rewritten}您看下是否清楚，不清楚我再帮您确认。`
                : rewritten;
        }
        else if (isCasualCustomerMessage(message)) {
            if (/谢谢|多谢|感谢/.test(message))
                drafted = '不客气，有需要随时找我～';
            else if (/拜拜|再见/.test(message))
                drafted = '好的，祝您生活愉快，再见。';
            else if (/好的|嗯|收到|明白|了解|知道了|ok/i.test(message))
                drafted = '好的，还有什么需要帮忙的直接说就行。';
            else
                drafted = '您好，我在的，请问有什么可以帮您？';
        }
        else if (/都有哪些|有哪些套餐|套餐有什么|哪些套餐/.test(message)) {
            drafted = '团购套餐名称和价格以您浏览的详情页为准。您方便说下想了解洗护、鞋靴还是家纺，我按品类帮您对照说明。';
        }
        else if (timedOut) {
            drafted = '抱歉让您久等了，我这边核对得慢一点，需要的话我帮您转人工继续确认。';
        }
        else {
            drafted = '这个点我需要再帮您确认一下，您方便说得再具体一点吗？';
        }
        const content = sanitizeCustomerReply(drafted, message, { hasRagEvidence: Boolean(rewritten) })
            || (timedOut
                ? '抱歉让您久等了，需要的话我帮您转人工确认一下。'
                : '这个我帮您转人工确认一下。');
        return {
            content,
            confidence: rewritten ? 0.55 : (isCasualCustomerMessage(message) ? 0.6 : 0),
            raw: {
                provider: 'local-fallback',
                reason,
                timedOut,
                emptyModelOutput: Boolean(options.emptyModelOutput)
            }
        };
    }
}

function isTimeoutError(error) {
    if (!error)
        return false;
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
        return true;
    const message = String(error.message || error);
    return /timeout|aborted|AbortError|TimeoutError/i.test(message);
}
