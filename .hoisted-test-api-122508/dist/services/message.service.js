// @ts-nocheck
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
        return { conversation, message: saved, duplicated: false };
    }
    async getRecentHistory(conversationId, limit = 8) {
        const messages = await prisma.message.findMany({
            where: { conversationId },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
        return messages.reverse().map((item) => ({
            role: item.direction === 'outbound' ? 'assistant' : 'user',
            content: item.content ?? ''
        }));
    }
}
