// @ts-nocheck
import { prisma } from '../lib/prisma.js';
export async function conversationRoutes(app) {
    app.get('/conversations', async () => {
        return prisma.conversation.findMany({
            orderBy: { updatedAt: 'desc' },
            take: 50
        });
    });
    app.get('/conversations/:id/messages', async (request) => {
        const { id } = request.params;
        return prisma.message.findMany({
            where: { conversationId: id },
            orderBy: { createdAt: 'asc' }
        });
    });
}
