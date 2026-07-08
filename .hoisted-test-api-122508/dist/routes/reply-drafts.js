// @ts-nocheck
import { prisma } from '../lib/prisma.js';
import { SendService } from '../services/send.service.js';
export async function replyDraftRoutes(app) {
    const sendService = new SendService();
    app.get('/reply-drafts/recent', async (request) => {
        const query = request.query;
        const limit = Math.min(Number(query.limit ?? 20), 50);
        if (!query.platform || !query.conversationId) {
            return { ok: false, drafts: [], error: '缺少 platform 或 conversationId' };
        }
        const conversation = await prisma.conversation.findUnique({
            where: {
                platform_platformConversationId: {
                    platform: query.platform,
                    platformConversationId: query.conversationId
                }
            }
        });
        if (!conversation) {
            return { ok: true, drafts: [] };
        }
        const drafts = await prisma.replyDraft.findMany({
            where: {
                conversationId: conversation.id
            },
            include: {
                message: true
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: limit
        });
        // RPA mock watcher 会轮询这个接口，把新草稿回显到测试聊天页。
        // 真实抖音/美团接入时，这里可替换为人工审核台或 RPA sender 队列。
        return {
            ok: true,
            drafts: drafts.reverse().map((draft) => ({
                id: draft.id,
                messageId: draft.messageId,
                userMessage: draft.message.content,
                content: draft.content,
                status: draft.status,
                riskLevel: draft.riskLevel,
                reason: draft.reason,
                createdAt: draft.createdAt
            }))
        };
    });
    app.post('/reply-drafts/:id/approve', async (request, reply) => {
        const { id } = request.params;
        const draft = await prisma.replyDraft.findUnique({
            where: { id },
            include: { conversation: true }
        });
        if (!draft)
            return reply.code(404).send({ ok: false, error: '草稿不存在' });
        const sendResult = await sendService.send({
            platform: draft.conversation.platform,
            shopId: draft.conversation.shopId,
            conversationId: draft.conversation.platformConversationId,
            customerId: draft.conversation.customerId,
            content: draft.content
        });
        await prisma.replyDraft.update({
            where: { id },
            data: { status: sendResult.success ? 'approved' : 'send_failed' }
        });
        return reply.send({ ok: sendResult.success, sendResult });
    });
    app.post('/reply-drafts/:id/reject', async (request, reply) => {
        const { id } = request.params;
        await prisma.replyDraft.update({
            where: { id },
            data: { status: 'rejected' }
        });
        return reply.send({ ok: true });
    });
    app.post('/reply-drafts/:id/mark-sent', async (request, reply) => {
        const { id } = request.params;
        // RPA sender 已经在浏览器里完成“填输入框 + 点击发送”后调用这里。
        // 标记 sent 可以避免 watcher 重启后再次发送同一条历史草稿。
        const draft = await prisma.replyDraft.update({
            where: { id },
            data: { status: 'sent' }
        });
        return reply.send({ ok: true, draft });
    });
}
