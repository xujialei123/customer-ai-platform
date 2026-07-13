// @ts-nocheck
/**
 * @file apps/api/src/routes/reply-drafts.ts
 * @module API Adapter 与路由
 * @description 回复草稿查询、批准、拒绝和 sent 标记。
 * @see 联动关注：Extension Gateway 与人工审核。
 */
import { prisma } from '../lib/prisma.js';
import { SendService } from '../services/send.service.js';
import { isRpaCustomerAllowed } from '../rpa/customer-allowlist.js';
export async function replyDraftRoutes(app) {
    const sendService = new SendService();
    app.get('/reply-drafts/recent', async (request) => {
        const query = request.query;
        const limit = Math.min(Number(query.limit ?? 20), 50);
        if (!query.platform || !query.conversationId) {
            return { ok: false, drafts: [], error: '缺少 platform 或 conversationId' };
        }
        const conversation = query.shopId
            ? await prisma.conversation.findUnique({
                where: {
                    platform_shopId_platformConversationId: {
                        platform: query.platform,
                        shopId: query.shopId,
                        platformConversationId: query.conversationId
                    }
                }
            })
            : await prisma.conversation.findFirst({
                where: { platform: query.platform, platformConversationId: query.conversationId }
            });
        if (!conversation) {
            return { ok: true, drafts: [] };
        }
        if (!isRpaCustomerAllowed({
            platform: conversation.platform,
            shopId: conversation.shopId,
            conversationId: conversation.platformConversationId,
            customerId: conversation.customerId,
            customerName: conversation.customerName ?? undefined
        })) {
            // 草稿查询再做一次服务端白名单兜底，避免旧插件或旧会话把历史草稿推给非测试客户。
            return { ok: true, drafts: [], ignored: true, reason: 'customer_not_allowed' };
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
        // 判断“这个问题有没有回过”必须绑在具体 messageId / 草稿内容上。
        // 不能用“之后任意 outbound”：经营宝页面回扫历史客服气泡时常用当前时间戳入库，
        // 会把刚生成的 pending 误判成已回复，随后被网关 reject，导致既不回填也不发送。
        const sentDraftMessageIds = new Set((await prisma.replyDraft.findMany({
            where: { conversationId: conversation.id, status: 'sent' },
            select: { messageId: true }
        })).map((item) => item.messageId));
        const recentOutbounds = await prisma.message.findMany({
            where: { conversationId: conversation.id, direction: 'outbound' },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: { content: true, createdAt: true }
        });
        const mapped = drafts.reverse().map((draft) => {
            const inboundTime = draft.message?.createdAt?.getTime?.() ?? new Date(draft.createdAt).getTime();
            const draftContent = String(draft.content ?? '').trim();
            const contentAlreadySent = Boolean(draftContent) && recentOutbounds.some((item) => {
                const outboundTime = new Date(item.createdAt).getTime();
                return outboundTime >= inboundTime && String(item.content ?? '').trim() === draftContent;
            });
            const alreadyReplied = sentDraftMessageIds.has(draft.messageId)
                || contentAlreadySent;
            return {
                id: draft.id,
                messageId: draft.messageId,
                userMessage: draft.message.content,
                content: draft.content,
                status: draft.status,
                riskLevel: draft.riskLevel,
                reason: draft.reason,
                createdAt: draft.createdAt,
                alreadyReplied
            };
        });
        // RPA mock watcher 会轮询这个接口，把新草稿回显到测试聊天页。
        // 真实抖音/美团接入时，这里可替换为人工审核台或 RPA sender 队列。
        return {
            ok: true,
            drafts: mapped
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
    app.post('/reply-drafts/:id/mark-dispatched', async (request, reply) => {
        const { id } = request.params;
        // 点击成功只代表浏览器完成了发送动作，不代表平台已经接收；页面观察到 outbound 后才由 MessageService 标记 sent。
        const result = await prisma.replyDraft.updateMany({
            where: { id, status: { in: ['pending', 'approved'] } },
            data: { status: 'dispatching' }
        });
        if (result.count === 0)
            return reply.code(409).send({ ok: false, error: '草稿不存在或当前状态不可发送' });
        return reply.send({ ok: true, status: 'dispatching' });
    });
}
