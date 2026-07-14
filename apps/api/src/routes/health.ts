/**
 * @file apps/api/src/routes/health.ts
 * @module API Adapter 与路由
 * @description API 健康检查与 LLM / Embedding 连接状态。
 * @see 联动关注：run-all 与 Doctor 脚本、model-config。
 */
// @ts-nocheck
import { env } from '../config/env.js';
import { getActiveEmbeddingTarget, getActiveLlmTarget } from '../config/model-config.js';

export async function healthRoutes(app) {
    app.get('/health', async () => {
        return { ok: true };
    });
    app.get('/health/llm', async () => {
        const llm = await getActiveLlmTarget();
        return {
            ok: llm.configured,
            configured: llm.configured,
            provider: llm.provider,
            model: llm.model,
            requiresLocalGateway: Boolean(llm.requiresLocalGateway)
        };
    });
    app.get('/health/embedding', async () => {
        const embedding = await getActiveEmbeddingTarget();
        return {
            ok: embedding.configured,
            configured: embedding.configured,
            model: embedding.model,
            baseUrl: embedding.baseUrl
        };
    });
    app.get('/health/openclaw', async () => {
        // 直连 LLM 时不再依赖本机 OpenClaw；保留接口供旧 Doctor 脚本兼容。
        const llm = await getActiveLlmTarget();
        if (!llm.requiresLocalGateway) {
            return {
                ok: llm.configured,
                configured: llm.configured,
                gatewayUrl: llm.chatUrl,
                provider: llm.provider,
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
