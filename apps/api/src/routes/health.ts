// @ts-nocheck
import { env } from '../config/env.js';
export async function healthRoutes(app) {
    app.get('/health', async () => {
        return { ok: true };
    });
    app.get('/health/openclaw', async () => {
        try {
            // 健康检查只访问本地网关根地址，不发送业务消息，也绝不返回 token 或模型服务密钥。
            const response = await fetch(env.OPENCLAW_GATEWAY_URL, {
                signal: AbortSignal.timeout(2000)
            });
            return {
                ok: response.status >= 200 && response.status < 500,
                configured: Boolean(env.OPENCLAW_TOKEN),
                gatewayUrl: env.OPENCLAW_GATEWAY_URL
            };
        }
        catch {
            return {
                ok: false,
                configured: Boolean(env.OPENCLAW_TOKEN),
                gatewayUrl: env.OPENCLAW_GATEWAY_URL
            };
        }
    });
}
