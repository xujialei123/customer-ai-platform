// @ts-nocheck
/**
 * @file apps/api/src/routes/orders.ts
 * @module API Adapter 与路由
 * @description 订单查询 HTTP 测试接口。
 * @see 联动关注：OrderService 和订单 Adapter。
 */
import { z } from 'zod';
import { OrderService } from '../services/order.service.js';
const querySchema = z.object({
    orderNo: z.string().min(6).max(64).optional(),
    phone: z.string().regex(/^1[3-9]\d{9}$/).optional()
}).refine((value) => Boolean(value.orderNo || value.phone), {
    message: 'orderNo 或 phone 至少提供一个'
});
export async function orderRoutes(app) {
    const orderService = new OrderService();
    // 手工验证公司订单 Adapter，不经过 OpenClaw，也不会修改订单。
    // 接真实系统前可以先用 TEST-ORDER-001 验证 mock 链路。
    app.post('/orders/query', async (request, reply) => {
        const { orderNo, phone } = querySchema.parse(request.body);
        if (orderNo) {
            const order = await orderService.queryOrder(orderNo);
            return reply.send({ ok: true, queryType: 'orderNo', order });
        }
        const orders = await orderService.queryOrdersByPhone(phone);
        return reply.send({ ok: true, queryType: 'phone', orders, count: orders.length });
    });
    app.post('/orders/chat-query', async (request, reply) => {
        const { message } = z.object({
            message: z.string().min(1).max(1000)
        }).parse(request.body);
        try {
            const result = await orderService.queryMessage(message);
            return reply.send({ ok: true, ...result });
        }
        catch (error) {
            // 对客户侧隐藏 token、业务码和后台字段，真实错误只由服务端日志记录。
            app.log.error(error);
            return reply.send({
                ok: false,
                matched: true,
                needHuman: true,
                answer: '您好，当前订单系统暂时无法查询，请联系人工客服协助核实。'
            });
        }
    });
}
