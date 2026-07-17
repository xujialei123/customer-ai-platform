// @ts-nocheck
/**
 * @file apps/api/src/routes/logs.ts
 * @module API Adapter 与路由
 * @description RPA 排查日志页：内存环形缓冲 + 便携包文件日志兜底。
 * @see 联动关注：terminal-log.ts、rpa-logs.html、getting-started。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRecentTerminalLogs, getRecentTerminalLogsFromFile } from '../utils/terminal-log.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');

function resolveLogsHtmlPath() {
    const candidates = [
        resolve(runtimeRoot, 'rpa-logs.html'),
        resolve(runtimeRoot, 'packaging/windows-portable/rpa-logs.html')
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}

function parseFilters(query) {
    return {
        limit: Number(query?.limit) || 120,
        afterId: Number(query?.afterId) || 0,
        event: String(query?.event || 'all'),
        platform: String(query?.platform || 'all'),
        customer: String(query?.customer || ''),
        q: String(query?.q || '')
    };
}

export async function logsRoutes(app) {
    app.get('/logs', async (_request, reply) => {
        const pagePath = resolveLogsHtmlPath();
        if (!pagePath) {
            reply.code(404).type('text/plain; charset=utf-8').send('RPA logs page not found.');
            return;
        }
        const html = await readFile(pagePath, 'utf-8');
        reply.type('text/html; charset=utf-8').send(html);
    });

    /**
     * 最近业务日志。
     * - 优先内存（结构化、可增量 afterId）
     * - 内存为空时读便携包 data/logs/api.out.log 尾部
     */
    app.get('/logs/recent', async (request) => {
        const filters = parseFilters(request.query || {});
        const memory = getRecentTerminalLogs(filters);
        if (memory.items.length > 0 || filters.afterId > 0) {
            return {
                ...memory,
                filters
            };
        }
        const file = getRecentTerminalLogsFromFile(filters);
        return {
            ...file,
            totalInMemory: memory.totalInMemory,
            latestId: memory.latestId,
            filters
        };
    });
}
