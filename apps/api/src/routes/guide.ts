// @ts-nocheck
/**
 * @file apps/api/src/routes/guide.ts
 * @module API Adapter 与路由
 * @description 便携包启动引导页与聚合状态接口。
 * @see 联动关注：getting-started.html、Start-Customer-AI.ps1。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { buildRpaAllowlistStatus, refreshRpaAllowlistCache } from '../rpa/customer-allowlist.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');

function resolveGuideHtmlPath() {
    const candidates = [
        resolve(runtimeRoot, 'getting-started.html'),
        resolve(runtimeRoot, 'packaging/windows-portable/getting-started.html')
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}

async function fetchJson(url, timeoutMs = 2500) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    return response.json();
}

export async function guideRoutes(app) {
    app.get('/guide', async (_request, reply) => {
        const guidePath = resolveGuideHtmlPath();
        if (!guidePath) {
            reply.code(404).type('text/plain; charset=utf-8').send('Guide page not found.');
            return;
        }
        const html = await readFile(guidePath, 'utf-8');
        reply.type('text/html; charset=utf-8').send(html);
    });

    app.get('/guide/status', async () => {
        await refreshRpaAllowlistCache().catch(() => undefined);
        const allowlist = buildRpaAllowlistStatus();
        const [openclaw, rag, extension, handoff] = await Promise.all([
            fetch(env.OPENCLAW_GATEWAY_URL, { signal: AbortSignal.timeout(2000) })
                .then((response) => ({
                    ok: response.status >= 200 && response.status < 500,
                    configured: Boolean(env.OPENCLAW_TOKEN),
                    gatewayUrl: env.OPENCLAW_GATEWAY_URL
                }))
                .catch(() => ({
                    ok: false,
                    configured: Boolean(env.OPENCLAW_TOKEN),
                    gatewayUrl: env.OPENCLAW_GATEWAY_URL
                })),
            fetchJson(`${env.RAG_SERVICE_URL.replace(/\/$/, '')}/health`).catch(() => ({ ok: false })),
            fetchJson(`http://127.0.0.1:${env.API_PORT}/rpa/extension/status`).catch(() => ({
                connectedClients: 0,
                autoSendClients: 0,
                rpaAutoSendEnabled: env.RPA_AUTO_SEND_ENABLED
            })),
            fetchJson(`http://127.0.0.1:${env.API_PORT}/handoff/count`).catch(() => ({ open: 0 }))
        ]);
        return {
            ok: true,
            api: { ok: true },
            openclaw,
            rag,
            extension,
            handoff: { open: Number(handoff?.open ?? 0) },
            config: {
                autoReplyEnabled: env.AUTO_REPLY_ENABLED,
                rpaAutoSendEnabled: env.RPA_AUTO_SEND_ENABLED,
                meituanRpaMode: process.env.MEITUAN_RPA_MODE ?? 'extension',
                meituanAllowedCustomers: allowlist.meituanAllowedCustomers,
                meituanAllowlistEnabled: allowlist.meituanAllowlistEnabled,
                douyinAllowedCustomers: allowlist.douyinAllowedCustomers,
                douyinAllowlistEnabled: allowlist.douyinAllowlistEnabled,
                meituanSendButtonSelector: process.env.MEITUAN_RPA_SEND_BUTTON_SELECTOR ?? ''
            }
        };
    });
}
