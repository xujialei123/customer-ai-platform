// @ts-nocheck
import { env } from '../config/env.js';
async function retry(task, times = 2) {
    // 通用 Provider 可配置有限重试；客服实时链路中的 OpenClaw 会单独关闭重试，避免长时间阻塞。
    let lastError;
    for (let attempt = 0; attempt <= times; attempt += 1) {
        try {
            return await task();
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}
export class MockLLMProvider {
    // Mock 仅验证调用链，不具备证据判断能力，生产环境不得用它评价客服回答质量。
    async chat(input) {
        const context = input.prompt.match(/【知识库内容】\n([\s\S]*?)\n\n【用户问题】/)?.[1]?.trim();
        if (!context)
            return '这个问题我需要帮您转人工确认一下，请稍等。';
        const firstLine = context.split('\n').find((line) => line.trim())?.replace(/^\d+\.\s*/, '').trim();
        return firstLine ? `您好，${firstLine.slice(0, 180)}` : '这个问题我需要帮您转人工确认一下，请稍等。';
    }
}
export class OpenAICompatibleLLMProvider {
    // 将厂商差异收敛到 OpenAI 兼容协议，Prompt 和风控仍由本项目统一管理。
    async chat(input) {
        return retry(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
                const response = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${env.LLM_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal,
                    body: JSON.stringify({
                        model: env.LLM_MODEL,
                        messages: [
                            ...(input.history ?? []),
                            { role: 'user', content: input.prompt }
                        ]
                    })
                });
                if (!response.ok)
                    throw new Error(`LLM 请求失败：${response.status} ${await response.text()}`);
                const json = await response.json();
                return String(json.choices?.[0]?.message?.content ?? '').trim();
            }
            finally {
                clearTimeout(timer);
            }
        });
    }
}
export class AgenesLLMProvider {
    // Agenes 是保留的外部 Adapter，返回字段只做兼容读取，不假设其内部模型行为。
    async chat(input) {
        return retry(async () => {
            const response = await fetch(env.AGENES_API_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.AGENES_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(input)
            });
            if (!response.ok)
                throw new Error(`Agenes 请求失败：${response.status} ${await response.text()}`);
            const json = await response.json();
            return String(json.answer ?? json.reply ?? json.content ?? '').trim();
        });
    }
}
export class OpenClawLLMProvider {
    // OpenClaw 只组织已经召回的证据，不直接操作平台、订单接口或发送按钮。
    async chat(input) {
        // 客服链路不能因为模型网关连续重试阻塞 90 秒；单次失败由上层立即转人工处理。
        return retry(async () => {
            const response = await fetch(`${env.OPENCLAW_GATEWAY_URL}${env.OPENCLAW_CHAT_ENDPOINT}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.OPENCLAW_TOKEN}`,
                    'Content-Type': 'application/json; charset=utf-8'
                },
                signal: AbortSignal.timeout(env.OPENCLAW_TIMEOUT_MS),
                body: JSON.stringify({
                    model: env.OPENCLAW_MODEL,
                    messages: [
                        ...(input.history ?? []),
                        { role: 'user', content: input.prompt }
                    ]
                })
            });
            if (!response.ok)
                throw new Error(`OpenClaw 请求失败：${response.status}`);
            const json = await response.json();
            return String(json.choices?.[0]?.message?.content ?? '').trim();
        }, 0);
    }
}
export function createLLMProvider() {
    // 普通知识库回复也统一走 OpenClaw，避免订单和 FAQ 使用两套不同模型链路。
    if (env.LLM_PROVIDER === 'openclaw' && env.OPENCLAW_TOKEN)
        return new OpenClawLLMProvider();
    if (env.LLM_PROVIDER === 'openai-compatible' && env.LLM_API_KEY)
        return new OpenAICompatibleLLMProvider();
    if (env.LLM_PROVIDER === 'agenes')
        return new AgenesLLMProvider();
    return new MockLLMProvider();
}
