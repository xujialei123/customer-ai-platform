// @ts-nocheck
/**
 * @file apps/api/src/routes/handoff.ts
 * @module API Adapter 与路由
 * @description 转人工工作台：复用 ReplyDraft 高/中风险草稿，提供列表与已处理标记。
 * @see 联动关注：SafetyService、reply-drafts、handoff.html。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');

const HANDOFF_RISK_LEVELS = ['high', 'medium'];
const OPEN_STATUSES = ['pending', 'approved', 'dispatching'];

function resolveHandoffHtmlPath() {
    const candidates = [
        resolve(runtimeRoot, 'handoff.html'),
        resolve(runtimeRoot, 'packaging/windows-portable/handoff.html')
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}

function mapHandoffDraft(draft) {
    return {
        id: draft.id,
        platform: draft.conversation?.platform,
        shopId: draft.conversation?.shopId,
        conversationId: draft.conversation?.platformConversationId,
        customerId: draft.conversation?.customerId,
        customerName: draft.conversation?.customerName,
        messageId: draft.messageId,
        userMessage: draft.message?.content ?? '',
        content: draft.content,
        status: draft.status,
        riskLevel: draft.riskLevel,
        reason: draft.reason,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt
    };
}

export async function handoffRoutes(app) {
    app.get('/handoff', async (_request, reply) => {
        const pagePath = resolveHandoffHtmlPath();
        if (!pagePath) {
            reply.code(404).type('text/plain; charset=utf-8').send('Handoff page not found.');
            return;
        }
        const html = await readFile(pagePath, 'utf-8');
        reply.type('text/html; charset=utf-8').send(html);
    });

    // 开放中的转人工条数，供引导页角标使用。
    app.get('/handoff/count', async () => {
        const open = await prisma.replyDraft.count({
            where: {
                riskLevel: { in: HANDOFF_RISK_LEVELS },
                status: { in: OPEN_STATUSES }
            }
        });
        return { ok: true, open };
    });

    app.get('/handoff/list', async (request) => {
        const query = z.object({
            view: z.enum(['open', 'handled', 'all']).default('open'),
            limit: z.coerce.number().int().positive().max(100).default(50)
        }).parse(request.query);

        const where = {
            riskLevel: { in: HANDOFF_RISK_LEVELS },
            ...(query.view === 'open'
                ? { status: { in: OPEN_STATUSES } }
                : query.view === 'handled'
                    ? { status: 'handled' }
                    : {})
        };

        const drafts = await prisma.replyDraft.findMany({
            where,
            include: {
                message: true,
                conversation: true
            },
            orderBy: { createdAt: 'desc' },
            take: query.limit
        });

        const openCount = await prisma.replyDraft.count({
            where: {
                riskLevel: { in: HANDOFF_RISK_LEVELS },
                status: { in: OPEN_STATUSES }
            }
        });

        return {
            ok: true,
            view: query.view,
            openCount,
            items: drafts.map(mapHandoffDraft)
        };
    });

    // 人工已在平台侧接手后，把本草稿移出待处理队列，避免继续占用工作台。
    app.post('/handoff/:id/handled', async (request, reply) => {
        const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
        const draft = await prisma.replyDraft.findUnique({
            where: { id },
            include: { conversation: true, message: true }
        });
        if (!draft)
            return reply.code(404).send({ ok: false, error: '转人工草稿不存在' });
        if (!HANDOFF_RISK_LEVELS.includes(draft.riskLevel))
            return reply.code(400).send({ ok: false, error: '该草稿不是转人工项' });
        if (draft.status === 'handled')
            return reply.send({ ok: true, item: mapHandoffDraft(draft), already: true });

        const updated = await prisma.replyDraft.update({
            where: { id },
            data: {
                status: 'handled',
                reason: draft.reason
                    ? `${draft.reason}｜人工已处理`
                    : '人工已处理'
            },
            include: { conversation: true, message: true }
        });
        // 会话层轻量标记：仍有未处理高风险草稿则保持 needs_human，否则回到 open。
        const remaining = await prisma.replyDraft.count({
            where: {
                conversationId: draft.conversationId,
                riskLevel: { in: HANDOFF_RISK_LEVELS },
                status: { in: OPEN_STATUSES }
            }
        });
        await prisma.conversation.update({
            where: { id: draft.conversationId },
            data: { status: remaining > 0 ? 'needs_human' : 'open' }
        });
        return reply.send({ ok: true, item: mapHandoffDraft(updated) });
    });
}
