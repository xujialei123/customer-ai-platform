// @ts-nocheck
/**
 * @file apps/api/src/rpa/customer-allowlist.ts
 * @module RPA 与 Chrome 插件
 * @description 真实平台灰度测试客户白名单；空列表表示允许全部客户。
 * @see 联动关注：allowlist-config.ts、extension-gateway.ts、Chrome 插件同步逻辑。
 */
import { env } from '../config/env.js';
import { getRpaAllowlistConfig } from './allowlist-config.js';

function parseAllowedCustomers(raw) {
    return String(raw || '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/** 内存缓存，避免每次 inbound 都读盘；配置页保存后会 refresh。 */
let cached = {
    meituan: parseAllowedCustomers(env.MEITUAN_RPA_ALLOWED_CUSTOMERS),
    douyin: parseAllowedCustomers(env.DOUYIN_RPA_ALLOWED_CUSTOMERS)
};
let refreshPromise = null;

export function getMeituanAllowedCustomers() {
    return cached.meituan;
}

export function getDouyinAllowedCustomers() {
    return cached.douyin;
}

function isCustomerAllowed(payload, allowedCustomers) {
    // 白名单为空 = 不限制，所有客户都可进入回复链路。
    if (!allowedCustomers.length)
        return true;
    const candidates = [
        payload.customerId,
        payload.conversationId,
        payload.customerName
    ].filter(Boolean).map(String);
    return allowedCustomers.some((allowed) => candidates.includes(allowed)
        || candidates.some((candidate) => candidate.includes(allowed)));
}

export function isRpaCustomerAllowed(payload) {
    if (payload?.platform === 'douyin')
        return isCustomerAllowed(payload, getDouyinAllowedCustomers());
    if (payload?.platform === 'meituan')
        return isCustomerAllowed(payload, getMeituanAllowedCustomers());
    return true;
}

export function buildRpaAllowlistStatus() {
    const meituanAllowedCustomers = getMeituanAllowedCustomers();
    const douyinAllowedCustomers = getDouyinAllowedCustomers();
    return {
        meituanAllowedCustomers,
        meituanAllowlistEnabled: meituanAllowedCustomers.length > 0,
        douyinAllowedCustomers,
        douyinAllowlistEnabled: douyinAllowedCustomers.length > 0
    };
}

/**
 * 从 local/env 刷新内存白名单；配置页保存后必须调用。
 */
export async function refreshRpaAllowlistCache() {
    if (refreshPromise)
        return refreshPromise;
    refreshPromise = (async () => {
        const config = await getRpaAllowlistConfig();
        cached = {
            meituan: config.meituan,
            douyin: config.douyin
        };
        return buildRpaAllowlistStatus();
    })().finally(() => {
        refreshPromise = null;
    });
    return refreshPromise;
}

// 启动时异步加载 local 覆盖，不阻塞主流程。
void refreshRpaAllowlistCache().catch(() => undefined);
