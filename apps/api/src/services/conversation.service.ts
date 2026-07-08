// @ts-nocheck
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma.js';
export class ConversationService {
    // 根据平台会话 ID 查找或创建会话。
    // 这样企业微信、抖音、美团都能映射到本系统统一 conversation。
    async findOrCreateConversation(message) {
        const existed = await prisma.conversation.findUnique({
            where: {
                platform_shopId_platformConversationId: {
                    platform: message.platform,
                    shopId: message.shopId,
                    platformConversationId: message.conversationId
                }
            }
        });
        if (existed) {
            // 客户昵称可能变化，保留平台最新值，不能因为会话已存在就永久显示旧昵称。
            if (message.customerName && message.customerName !== existed.customerName) {
                return prisma.conversation.update({
                    where: { id: existed.id },
                    data: { customerName: message.customerName }
                });
            }
            return existed;
        }
        // MVP 为了方便测试，如果 shop 不存在就自动创建。
        // 正式版本建议改成必须先在后台配置门店。
        await prisma.shop.upsert({
            where: { id: message.shopId },
            update: {},
            create: {
                id: message.shopId,
                name: message.shopId
            }
        });
        return prisma.conversation.create({
            data: {
                id: nanoid(),
                platform: message.platform,
                shopId: message.shopId,
                platformConversationId: message.conversationId,
                customerId: message.customerId,
                customerName: message.customerName
            }
        });
    }
}
