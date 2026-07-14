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
        // 若近 10 分钟内已有同正文入站，且仍在处理中或已有草稿，则视为重复，不再入队。
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
     * 查找「同会话同正文」的近期入站，用于抵消扩展 messageId 不稳定造成的假新消息。
     * 客户短时间真心连发同一句（如两次你好）仍允许：仅在已有草稿/仍在处理窗口时拦截。
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
        // 精确同文，或流式残文/加长句（「你」↔「你好」）都视为同一条入站抖动。
        const recent = recentMessages.find((item) => {
            const previous = String(item.content ?? '').trim();
            if (!previous)
                return false;
            if (previous === normalized)
                return true;
            if (normalized.length <= 40 && previous.length <= 200
                && (normalized.startsWith(previous) || previous.startsWith(normalized)))
                return true;
            return false;
        });
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
        if (draft?.status === 'sent') {
            // 已完整回复后，允许顾客稍后再发同一句；仅拦截发送后短窗口内的 ID 抖动重提。
            if (ageMs >= 0 && ageMs < 90 * 1000)
                return recent;
            return null;
        }
        if (draft)
            return recent;
        // 草稿尚未写出（RAG/OpenClaw 仍在跑）时也拦截，避免并发双开 Worker。
        if (ageMs >= 0 && ageMs < 5 * 60 * 1000)
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
    async getRecentHistory(conversationId, limit = 12, excludeMessageId) {
        // 当前问题会单独传给模型，因此从历史中排除，避免同一句重复出现造成模型误判。
        const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
        const messages = await prisma.message.findMany({
            where: { conversationId, ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}) },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
        const history = messages.reverse().map((item) => ({
            role: item.direction === 'outbound' ? 'assistant' : 'user',
            content: item.content ?? ''
        }));
        if (conversation?.summary) {
            history.unshift({ role: 'system', content: `较早会话摘要：\n${conversation.summary}` });
        }
        return history;
    }
    async refreshConversationSummary(conversationId) {
        // 较早历史压缩到数据库摘要，服务重启后仍可恢复；摘要不缓存实时订单状态。
        const total = await prisma.message.count({ where: { conversationId } });
        if (total <= 12)
            return;
        const olderMessages = await prisma.message.findMany({
            where: { conversationId },
            orderBy: { createdAt: 'desc' },
            skip: 12,
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
