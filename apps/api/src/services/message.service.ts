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
        const saved = await prisma.message.create({
            data: {
                id: message.id,
                conversationId: conversation.id,
                platform: message.platform,
                direction: 'inbound',
                messageType: message.messageType,
                content: message.content,
                raw: message.raw
            }
        });
        await this.refreshConversationSummary(conversation.id);
        return { conversation, message: saved, duplicated: false };
    }
    // 保存人工或 RPA 已实际发送到平台的消息，使下一轮 OpenClaw 能看到客服已经说过什么。
    async saveOutboundMessage(message) {
        const conversation = await this.conversationService.findOrCreateConversation(message);
        const existed = await prisma.message.findUnique({ where: { id: message.id } });
        if (existed)
            return { conversation, message: existed, duplicated: true };
        const saved = await prisma.message.create({
            data: {
                id: message.id,
                conversationId: conversation.id,
                platform: message.platform,
                direction: 'outbound',
                messageType: message.messageType ?? 'text',
                content: message.content,
                raw: message.raw ?? message,
                aiGenerated: Boolean(message.aiGenerated)
            }
        });
        // 页面观察到相同内容已经发出时，把对应待审核草稿标记 sent，避免再次回填。
        const matchingDraft = await prisma.replyDraft.findFirst({
            where: { conversationId: conversation.id, content: message.content, status: { in: ['pending', 'approved'] } },
            orderBy: { createdAt: 'desc' }
        });
        if (matchingDraft) {
            await prisma.replyDraft.update({ where: { id: matchingDraft.id }, data: { status: 'sent' } });
        }
        await this.refreshConversationSummary(conversation.id);
        return { conversation, message: saved, duplicated: false };
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
