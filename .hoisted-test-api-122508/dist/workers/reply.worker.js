// @ts-nocheck
import { Worker } from 'bullmq';
import { nanoid } from 'nanoid';
import { env } from '../config/env.js';
import { redisConnection } from '../lib/queue.js';
import { prisma } from '../lib/prisma.js';
import { MessageService } from '../services/message.service.js';
import { OpenClawClient } from '../services/openclaw.service.js';
import { OrderService } from '../services/order.service.js';
import { RagService } from '../services/rag.service.js';
import { SafetyService } from '../services/safety.service.js';
import { SendService } from '../services/send.service.js';
const ragService = new RagService();
const messageService = new MessageService();
const openClawClient = new OpenClawClient();
const orderService = new OrderService();
const safetyService = new SafetyService();
const sendService = new SendService();
// 启动异步回复 Worker。
// 生产环境可以独立进程运行；MVP 先随 API 服务一起启动。
export function startReplyWorker() {
    return new Worker('inbound-message', async (job) => {
        const { messageId } = job.data;
        const inboundMessage = await prisma.message.findUnique({
            where: { id: messageId },
            include: { conversation: true }
        });
        if (!inboundMessage || !inboundMessage.content)
            return;
        const conversation = inboundMessage.conversation;
        // 先检索知识库，再让 AI 基于知识库回答。
        const ragContext = await ragService.search({
            shopId: conversation.shopId,
            query: inboundMessage.content,
            topK: 6
        });
        // 订单查询只在明确识别到订单意图和订单号时调用公司系统，避免每条闲聊都访问内部接口。
        // 查询结果会转换成脱敏、只读的检索片段，与知识库一起交给 OpenClaw，不暴露原始接口数据。
        const orderNo = orderService.extractOrderNo(inboundMessage.content);
        const orderPhone = orderService.extractPhone(inboundMessage.content);
        if (orderNo) {
            try {
                const order = await orderService.queryOrder(orderNo);
                ragContext.unshift(orderService.toRagHit(order));
            }
            catch (error) {
                console.warn('[ReplyWorker] 公司订单系统查询失败，保留人工处理：', error instanceof Error ? error.message : String(error));
            }
        }
        else if (orderPhone) {
            try {
                const orders = await orderService.queryOrdersByPhone(orderPhone);
                ragContext.unshift(orderService.toPhoneRagHit(orderPhone, orders));
            }
            catch (error) {
                console.warn('[ReplyWorker] 公司订单系统按手机号查询失败，保留人工处理：', error instanceof Error ? error.message : String(error));
            }
        }
        else if (orderService.isOrderQuery(inboundMessage.content)) {
            // 没提供订单号时不猜测，加入明确提示，让模型只向客户索要订单号。
            ragContext.unshift({
                id: 'order-system:missing-order-no',
                content: '公司订单系统查询前置条件：客户尚未提供订单号，请礼貌请客户提供订单号，不得猜测订单状态。',
                metadata: { source: 'company-order-system', trusted: true },
                score: 1
            });
        }
        const preRisk = safetyService.checkRisk({
            userMessage: inboundMessage.content,
            ragHitCount: ragContext.length
        });
        const history = await messageService.getRecentHistory(conversation.id);
        let reply = '这个我帮您转人工确认一下。';
        let raw = {};
        // 命中高风险问题时不调用模型生成承诺类话术，直接转人工。
        // 这样可以减少退款、投诉、赔偿等场景下模型越权回复的概率。
        if (preRisk.riskLevel !== 'high') {
            try {
                const result = await openClawClient.generateReply({
                    message: inboundMessage.content,
                    conversationHistory: history,
                    ragContext
                });
                reply = result.content;
                raw = result.raw;
            }
            catch (error) {
                console.warn('[ReplyWorker] OpenClaw 生成失败，已转为人工草稿：', error instanceof Error ? error.message : String(error));
                reply = '这个我帮您转人工确认一下。';
                raw = { error: error instanceof Error ? error.message : String(error) };
            }
        }
        const finalRisk = safetyService.checkRisk({
            userMessage: inboundMessage.content,
            aiReply: reply,
            ragHitCount: ragContext.length
        });
        const shouldAutoSend = env.AUTO_REPLY_ENABLED && finalRisk.allowAutoSend;
        if (shouldAutoSend) {
            // 只有全局自动回复开启且最终风控允许时才进入发送出口。
            // 抖音/美团的 SendService 还会额外检查 RPA_AUTO_SEND_ENABLED，默认不会真实发送。
            const sendResult = await sendService.send({
                platform: conversation.platform,
                shopId: conversation.shopId,
                conversationId: conversation.platformConversationId,
                customerId: conversation.customerId,
                content: reply
            });
            if (sendResult.success) {
                await prisma.message.create({
                    data: {
                        id: nanoid(),
                        conversationId: conversation.id,
                        platform: conversation.platform,
                        direction: 'outbound',
                        messageType: 'text',
                        content: reply,
                        aiGenerated: true,
                        raw: { sendResult, openclaw: raw }
                    }
                });
            }
            else {
                // 自动发送失败时不要伪造成已发消息，转成草稿让人工确认。
                await prisma.replyDraft.create({
                    data: {
                        id: nanoid(),
                        conversationId: conversation.id,
                        messageId: inboundMessage.id,
                        content: reply,
                        status: 'pending',
                        riskLevel: finalRisk.riskLevel,
                        reason: sendResult.error ?? finalRisk.reason ?? '自动发送失败，需要人工审核',
                        ragContext: ragContext
                    }
                });
            }
        }
        else {
            // 默认路径：生成回复草稿，由人工审核。
            await prisma.replyDraft.create({
                data: {
                    id: nanoid(),
                    conversationId: conversation.id,
                    messageId: inboundMessage.id,
                    content: reply,
                    status: 'pending',
                    riskLevel: finalRisk.riskLevel,
                    reason: finalRisk.reason,
                    ragContext: ragContext
                }
            });
        }
    }, { connection: redisConnection });
}
