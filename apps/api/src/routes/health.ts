// @ts-nocheck
/**
 * @file apps/api/src/routes/health.ts
 * @module API Adapter 与路由
 * @description API 健康检查与 LLM / OpenClaw 连接状态。
 * @see 联动关注：run-all 与 Doctor 脚本。
 */
import { env } from '../config/env.js';
export async function healthRoutes(app) {
    app.get('/health', async () => {
        return { ok: true };
    });
    app.get('/health/llm', async () => {
        const configured = Boolean(env.LLM_CHAT_API_KEY && env.LLM_CHAT_URL)
            && !['replace-me', 'your_openclaw_token', 'your_llm_key', 'your_agenes_key', 'your_agnes_key']
                .includes(String(env.LLM_CHAT_API_KEY));
        return {
            ok: configured,
            configured,
            provider: env.LLM_PROVIDER,
            model: env.LLM_CHAT_MODEL,
            requiresLocalGateway: Boolean(env.LLM_REQUIRES_LOCAL_GATEWAY)
        };
    });
    app.get('/health/openclaw', async () => {
        // 直连 LLM 时不再依赖本机 OpenClaw；保留接口供旧 Doctor 脚本兼容。
        if (!env.LLM_REQUIRES_LOCAL_GATEWAY) {
            return {
                ok: true,
                configured: Boolean(env.LLM_CHAT_API_KEY),
                gatewayUrl: env.LLM_CHAT_URL,
                provider: env.LLM_PROVIDER,
                mode: 'direct-llm'
            };
        }
        try {
            const response = await fetch(env.OPENCLAW_GATEWAY_URL, {
                signal: AbortSignal.timeout(2000)
            });
            return {
                ok: response.status >= 200 && response.status < 500,
                configured: Boolean(env.OPENCLAW_TOKEN),
                gatewayUrl: env.OPENCLAW_GATEWAY_URL,
                mode: 'openclaw'
            };
        }
        catch {
            return {
                ok: false,
                configured: Boolean(env.OPENCLAW_TOKEN),
                gatewayUrl: env.OPENCLAW_GATEWAY_URL,
                mode: 'openclaw'
            };
        }
    });
}
