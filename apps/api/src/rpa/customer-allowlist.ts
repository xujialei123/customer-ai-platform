// @ts-nocheck
/**
 * @file apps/api/src/rpa/customer-allowlist.ts
 * @module RPA 与 Chrome 插件
 * @description 真实平台灰度测试客户白名单，避免 RPA 误处理非测试会话。
 * @see 联动关注：extension-gateway.ts、routes/rpa.ts、Chrome 插件同步逻辑。
 */
import { env } from '../config/env.js';

export function getMeituanAllowedCustomers() {
    // 环境变量为空表示不启用白名单；线上灰度时建议显式填写测试 customerId/conversationId。
    return env.MEITUAN_RPA_ALLOWED_CUSTOMERS.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

export function isRpaCustomerAllowed(payload) {
    if (payload?.platform !== 'meituan')
        return true;
    const allowedCustomers = getMeituanAllowedCustomers();
    if (!allowedCustomers.length)
        return true;
    const candidates = [
        payload.customerId,
        payload.conversationId,
        payload.customerName
    ].filter(Boolean).map(String);
    // 美团页面不同位置可能暴露 userId、conversationId 或昵称；服务端只做精确匹配，避免误伤相似客户。
    return allowedCustomers.some((allowed) => candidates.includes(allowed));
}

export function buildRpaAllowlistStatus() {
    const allowedCustomers = getMeituanAllowedCustomers();
    return {
        meituanAllowedCustomers: allowedCustomers,
        meituanAllowlistEnabled: allowedCustomers.length > 0
    };
}
