// @ts-nocheck
/**
 * @file apps/api/src/workers/reply.worker.ts
 * @module API Service 与 Worker
 * @description 消费 inbound 队列：先订单路由，再 RAG，再 OpenClaw、风控和草稿生成。
 * @see 联动关注：回复主链路排障入口。
 */
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
import { terminalLog } from '../utils/terminal-log.js';
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
        const startedAt = Date.now();
        let ragMs = 0;
        let openclawMs = 0;
        // 必须先恢复多轮上下文并执行订单路由；订单号属于工具参数，不能先送到知识库检索。
        // 多取几轮；默认只生成草稿时会把 pending 草稿并入历史，模型才能「记住」上一句客服怎么说。
        const history = await messageService.getRecentHistory(conversation.id, 16, inboundMessage.id);
        const awaitingOrderIdentifier = orderService.isAwaitingOrderIdentifier(history);
        // 客户先说「查订单」再单独发单号时，即使客服话术没命中 awaiting 模板，也应走订单系统。
        const allowBareOrderId = awaitingOrderIdentifier || orderService.hasRecentOrderContext(history);
        const ragContext = [];
        // 当前句有查单意图，或近轮已在查单时，才允许把纯字母数字串当作订单号。
        // 查询结果会转换成脱敏、只读的检索片段，与知识库一起交给 OpenClaw，不暴露原始接口数据。
        const orderNo = orderService.extractOrderNo(inboundMessage.content)
            ?? (allowBareOrderId ? orderService.extractOrderNoCandidate(inboundMessage.content) : null);
        const orderPhone = orderService.extractPhone(inboundMessage.content)
            ?? (allowBareOrderId ? orderService.extractPhoneCandidate(inboundMessage.content) : null);
        let routedToOrderSystem = false;
        if (orderNo) {
            routedToOrderSystem = true;
            try {
                const order = await orderService.queryOrder(orderNo);
                ragContext.unshift(orderService.toRagHit(order));
            }
            catch (error) {
                console.warn('[ReplyWorker] 公司订单系统查询失败，保留人工处理：', error instanceof Error ? error.message : String(error));
            }
        }
        else if (orderPhone) {
            routedToOrderSystem = true;
            try {
                const orders = await orderService.queryOrdersByPhone(orderPhone);
                ragContext.unshift(orderService.toPhoneRagHit(orderPhone, orders));
            }
            catch (error) {
                console.warn('[ReplyWorker] 公司订单系统按手机号查询失败，保留人工处理：', error instanceof Error ? error.message : String(error));
            }
        }
        else if (orderService.isOrderQuery(inboundMessage.content)) {
            routedToOrderSystem = true;
            // 没提供订单号时不猜测，加入明确提示，让模型只向客户索要订单号。
            ragContext.unshift({
                id: 'order-system:missing-order-no',
                content: '公司订单系统查询前置条件：客户尚未提供订单号，请礼貌请客户提供订单号，不得猜测订单状态。',
                metadata: { source: 'company-order-system', trusted: true },
                score: 1
            });
        }
        if (!routedToOrderSystem) {
            // 只有非订单消息才进入 Hybrid RAG，避免订单号被当成普通知识问题。
            const ragStarted = Date.now();
            ragContext.push(...await ragService.search({
                platform: conversation.platform,
                shopId: conversation.shopId,
                query: inboundMessage.content,
                topK: 6
            }));
            ragMs = Date.now() - ragStarted;
        }
        const preRisk = safetyService.checkRisk({
            userMessage: inboundMessage.content,
            ragHitCount: ragContext.length
        });
        // 当前消息会在 userContent 中单独传入，history 已在订单路由前读取并排除了当前消息。
        let reply = '这个我帮您转人工确认一下。';
        let raw = {};
        // 命中高风险问题时不调用模型生成承诺类话术，直接转人工。
        // 这样可以减少退款、投诉、赔偿等场景下模型越权回复的概率。
        if (preRisk.riskLevel !== 'high') {
            try {
                const openclawStarted = Date.now();
                const result = await openClawClient.generateReply({
                    message: inboundMessage.content,
                    // 近 10 条轮次（含并入的待发草稿）；摘要单独传，避免 slice 丢掉前情。
                    conversationHistory: history.slice(-10),
                    conversationSummary: conversation.summary || undefined,
                    ragContext
                });
                openclawMs = Date.now() - openclawStarted;
                // 超时/失败兜底也必须有对客正文；空字符串时再铺一层人话，避免千篇一律。
                reply = String(result.content || '').trim()
                    || (result.raw?.timedOut
                        ? '抱歉让您久等了，我再帮您核对一下，稍等。'
                        : '不好意思，这个点我需要再确认一下，您方便说得再具体一点吗？');
                raw = result.raw;
            }
            catch (error) {
                console.warn('[ReplyWorker] OpenClaw 生成失败，已使用兜底话术：', error instanceof Error ? error.message : String(error));
                reply = '不好意思，我这边刚才有点卡，您方便再说一下具体想咨询什么吗？';
                raw = { error: error instanceof Error ? error.message : String(error) };
            }
        }
        const finalRisk = safetyService.checkRisk({
            userMessage: inboundMessage.content,
            aiReply: reply,
            ragHitCount: ragContext.length
        });
        terminalLog('rag', {
            platform: conversation.platform,
            customer: conversation.customerName || conversation.customerId,
            ragHits: ragContext.length,
            userMessage: inboundMessage.content,
            ragPreview: ragContext.slice(0, 3).map((item) => item.content ?? item.id ?? String(item)),
            method: `rag=${ragMs}ms openclaw=${openclawMs}ms total=${Date.now() - startedAt}ms`
        });
        // 抖音/美团真实发送只能由 Chrome 插件或 Playwright 在浏览器里完成。
        // Adapter.sendMessage 只是占位失败，这里若走 SendService 会把草稿 reason 写成“自动发送未开启”，误导排查。
        const isBrowserRpaPlatform = conversation.platform === 'douyin' || conversation.platform === 'meituan';
        const shouldAutoSend = env.AUTO_REPLY_ENABLED && finalRisk.allowAutoSend && !isBrowserRpaPlatform;
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
                terminalLog('click_ok', {
                    platform: conversation.platform,
                    customer: conversation.customerName || conversation.customerId,
                    riskLevel: finalRisk.riskLevel,
                    content: reply,
                    method: 'adapter-send'
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
                // 只有高风险才进转人工台；空召回的 medium 仍可先用 AI 澄清，避免正常闲聊被标 needs_human。
                if (finalRisk.riskLevel === 'high') {
                    await prisma.conversation.update({
                        where: { id: conversation.id },
                        data: { status: 'needs_human' }
                    });
                }
                terminalLog('draft', {
                    platform: conversation.platform,
                    customer: conversation.customerName || conversation.customerId,
                    riskLevel: finalRisk.riskLevel,
                    userMessage: inboundMessage.content,
                    content: reply,
                    denyReason: sendResult.error ?? finalRisk.reason
                });
            }
        }
        else {
            // 默认路径：生成回复草稿。
            // 美团/抖音由插件根据 RPA_AUTO_SEND_ENABLED + 弹窗开关决定是否点击发送。
            const draftReason = finalRisk.reason
                ?? (raw?.timedOut ? 'LLM 超时，已使用本地兜底回复' : undefined)
                ?? (isBrowserRpaPlatform
                    ? (env.RPA_AUTO_SEND_ENABLED ? '等待浏览器 RPA/插件发送' : 'RPA 自动发送未开启，仅回填待确认')
                    : undefined);
            await prisma.replyDraft.create({
                data: {
                    id: nanoid(),
                    conversationId: conversation.id,
                    messageId: inboundMessage.id,
                    content: reply,
                    status: 'pending',
                    riskLevel: finalRisk.riskLevel,
                    reason: draftReason,
                    ragContext: ragContext
                }
            });
            // 高风险进入转人工工作台；medium（如暂无召回）仍保留 AI 草稿，不立刻 needs_human。
            if (finalRisk.riskLevel === 'high') {
                await prisma.conversation.update({
                    where: { id: conversation.id },
                    data: { status: 'needs_human' }
                });
            }
            terminalLog('draft', {
                platform: conversation.platform,
                customer: conversation.customerName || conversation.customerId,
                riskLevel: finalRisk.riskLevel,
                ragHits: ragContext.length,
                userMessage: inboundMessage.content,
                content: reply,
                denyReason: draftReason
            });
        }
    }, { connection: redisConnection });
}
