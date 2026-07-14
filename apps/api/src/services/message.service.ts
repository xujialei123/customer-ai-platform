// @ts-nocheck
/**
 * @file apps/api/src/services/message.service.ts
 * @module API Service 与 Worker
 * @description 消息去重、入库、摘要更新、outbound 确认和草稿关闭。
 * @see 联动关注：RPA outbound、ReplyDraft。
 */
import { prisma } from '../lib/prisma.js';
import { ConversationService } from './conversation.service.js';
export class MessageService {
    conversationService = new ConversationService();
    // 保存客户发来的消息。
    // 注意：message.id 使用平台原始消息 ID，便于去重。
    async saveInboundMessage(message) {
        const conversation = await this.conversationService.findOrCreateConversation(message);
        const existed = await prisma.message.findUnique({
            where: { id: message.id }
        });
        if (existed) {
            return { conversation, message: existed, duplicated: true };
        }
        // 内容短时去重：扩展 ID 抖动时，同一会话同一正文会带着新 id 反复入库。
        // 若近窗口内「同一条已处理中/刚发出」的同正文回扫，则视为重复，不再入队。
        // 客户继续咨询（哪怕措辞相近或过一会儿再问同一句）不得因软去重被丢掉。
        const softDuplicate = await this.findSoftDuplicateInbound(conversation.id, message.content);
        if (softDuplicate)
            return { conversation, message: softDuplicate, duplicated: true };
        let saved;
        try {
            saved = await prisma.message.create({
                data: {
                    id: message.id,
                    conversationId: conversation.id,
                    platform: message.platform,
                    direction: 'inbound',
                    messageType: message.messageType,
                    content: message.content,
                    raw: message.raw,
                    // 保留平台时间，消息排序不能被网络延迟或页面回扫时间替代。
                    createdAt: this.parseCreatedAt(message.createdAt)
                }
            });
        }
        catch (error) {
            // “先查再写”无法阻止两个并发回调同时通过查询；唯一键冲突时按重复消息返回，而不是把平台重试变成 500。
            if (error?.code !== 'P2002')
                throw error;
            const concurrent = await prisma.message.findUnique({ where: { id: message.id } });
            if (!concurrent)
                throw error;
            return { conversation, message: concurrent, duplicated: true };
        }
        await this.refreshConversationSummary(conversation.id);
        return { conversation, message: saved, duplicated: false };
    }
    /**
     * 抵消扩展 messageId 抖动造成的假「新消息」，不是业务层「客户不能重复提问」。
     * 判定关键看「这条是否已在处理/刚发出」：客户过一会儿再问同一句（继续咨询）必须放行。
     * 禁止用前缀相似（门店/门店在哪里、在吗/在吗在吗）拦后续问题。
     */
    async findSoftDuplicateInbound(conversationId, content, withinMs = 10 * 60 * 1000) {
        const normalized = String(content ?? '').trim();
        if (!normalized)
            return null;
        const recentMessages = await prisma.message.findMany({
            where: {
                conversationId,
                direction: 'inbound',
                createdAt: { gte: new Date(Date.now() - withinMs) }
            },
            orderBy: { createdAt: 'desc' },
            take: 20
        });
        // 只认「正文完全一致」的回扫；相似问法不算重复。
        const recent = recentMessages.find((item) => String(item.content ?? '').trim() === normalized);
        if (!recent)
            return null;
        const draft = await prisma.replyDraft.findFirst({
            where: {
                messageId: recent.id,
                status: { in: ['pending', 'approved', 'dispatching', 'sent'] }
            },
            orderBy: { createdAt: 'desc' }
        });
        const ageMs = Date.now() - new Date(recent.createdAt).getTime();
        if (draft?.status === 'sent' || draft?.status === 'dispatching') {
            // 刚发出/正在点发送：短窗口内同文多半是页面回扫气泡，不是客户再问一次。
            if (ageMs >= 0 && ageMs < 90 * 1000)
                return recent;
            return null;
        }
        if (draft && ['pending', 'approved'].includes(draft.status)) {
            // 草稿还在等插件：防双开 Worker；若超过 3 分钟仍未发出，放行让客户再触发一轮。
            if (ageMs >= 0 && ageMs < 3 * 60 * 1000)
                return recent;
            return null;
        }
        // 草稿尚未写出（RAG/LLM 仍在跑）：短窗口防并发双入队。
        if (ageMs >= 0 && ageMs < 2 * 60 * 1000)
            return recent;
        return null;
    }
    // 保存人工或 RPA 已实际发送到平台的消息，使下一轮 OpenClaw 能看到客服已经说过什么。
    async saveOutboundMessage(message) {
        const conversation = await this.conversationService.findOrCreateConversation(message);
        const existed = await prisma.message.findUnique({ where: { id: message.id } });
        if (existed)
            return { conversation, message: existed, duplicated: true };
        let saved;
        try {
            saved = await prisma.message.create({
                data: {
                    id: message.id,
                    conversationId: conversation.id,
                    platform: message.platform,
                    direction: 'outbound',
                    messageType: message.messageType ?? 'text',
                    content: message.content,
                    raw: message.raw ?? message,
                    aiGenerated: Boolean(message.aiGenerated),
                    createdAt: this.parseCreatedAt(message.createdAt)
                }
            });
        }
        catch (error) {
            if (error?.code !== 'P2002')
                throw error;
            const concurrent = await prisma.message.findUnique({ where: { id: message.id } });
            if (!concurrent)
                throw error;
            return { conversation, message: concurrent, duplicated: true };
        }
        // 页面观察到相同内容已经发出时，把对应待审核草稿标记 sent，避免再次回填。
        const matchingDraft = await prisma.replyDraft.findFirst({
            where: { conversationId: conversation.id, content: message.content, status: { in: ['pending', 'approved', 'dispatching'] } },
            orderBy: { createdAt: 'desc' }
        });
        if (matchingDraft) {
            await prisma.replyDraft.update({ where: { id: matchingDraft.id }, data: { status: 'sent' } });
        }
        await this.refreshConversationSummary(conversation.id);
        return { conversation, message: saved, duplicated: false };
    }
    parseCreatedAt(value) {
        if (!value)
            return undefined;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
    /**
     * 取近期多轮上下文给 LLM。
     * 抖音/美团默认只落 ReplyDraft、不写 outbound，若不把待发草稿并入历史，模型只会看到客户单边话，像「没有记忆」。
     * 会话摘要由 Worker 单独传入 generateReply，避免 slice 历史时把摘要砍掉。
     */
    async getRecentHistory(conversationId, limit = 16, excludeMessageId) {
        const messages = await prisma.message.findMany({
            where: { conversationId, ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}) },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
        const chronological = messages.reverse();
        const inboundIds = chronological
            .filter((item) => item.direction === 'inbound')
            .map((item) => item.id);
        const draftByMessageId = new Map();
        if (inboundIds.length > 0) {
            // 仅并入尚未真正发出的草稿；已 sent 的应以 outbound 消息为准，避免双份 assistant。
            const drafts = await prisma.replyDraft.findMany({
                where: {
                    conversationId,
                    messageId: { in: inboundIds },
                    status: { in: ['pending', 'approved'] }
                },
                orderBy: { createdAt: 'asc' }
            });
            for (const draft of drafts) {
                if (draft.messageId && draft.content)
                    draftByMessageId.set(draft.messageId, draft.content);
            }
        }
        const history = [];
        for (const item of chronological) {
            if (item.direction === 'inbound') {
                history.push({ role: 'user', content: item.content ?? '' });
                const draftContent = draftByMessageId.get(item.id);
                if (draftContent)
                    history.push({ role: 'assistant', content: draftContent });
            }
            else {
                history.push({ role: 'assistant', content: item.content ?? '' });
            }
        }
        return history;
    }
    async refreshConversationSummary(conversationId) {
        // 较早历史压缩到数据库摘要，服务重启后仍可恢复；摘要不缓存实时订单状态。
        const total = await prisma.message.count({ where: { conversationId } });
        // 与 getRecentHistory 窗口对齐：超过近期条数才压缩更早对话。
        if (total <= 16)
            return;
        const olderMessages = await prisma.message.findMany({
            where: { conversationId },
            orderBy: { createdAt: 'desc' },
            skip: 16,
            take: 24
        });
        // 摘要直接压缩数据库中的真实历史，不让模型改写事实；订单实时状态仍由订单 Adapter 每次重新查询。
        const summary = olderMessages.reverse().map((item) => {
            const speaker = item.direction === 'outbound' ? '客服' : '客户';
            return `${speaker}：${(item.content ?? '').replace(/\s+/g, ' ').slice(0, 180)}`;
        }).join('\n').slice(-3000);
        await prisma.conversation.update({
            where: { id: conversationId },
            data: { summary, summaryUpdatedAt: new Date() }
        });
    }
}
