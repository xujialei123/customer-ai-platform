// @ts-nocheck
/**
 * @file apps/api/src/services/order.service.ts
 * @module API Service 与 Worker
 * @description 订单号识别、多轮等待判断、公司系统查询和脱敏。
 * @see 联动关注：订单 Adapter 和 ReplyWorker 路由。
 */
import { sm2 } from 'sm-crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { OpenClawClient } from './openclaw.service.js';
const ADMIN_SM2_PUBLIC_KEY = '04298364ec840088475eae92a591e01284d1abefcda348b47eb324bb521bb03b0b2a5bc393f6b71dabb8f15c99a0050818b56b23f31743b93df9cf8948f15ddb54';
const orderResultSchema = z.object({
    found: z.boolean(),
    orderNo: z.string(),
    status: z.string().optional(),
    orderSource: z.string().optional(),
    amount: z.number().optional(),
    itemName: z.string().optional(),
    createdAt: z.string().optional(),
    paidAt: z.string().optional(),
    usageStatus: z.string().optional(),
    pickupStatus: z.string().optional(),
    deliveryStatus: z.string().optional(),
    storeName: z.string().optional(),
    contactNameMasked: z.string().optional(),
    contactPhoneMasked: z.string().optional(),
    deliveryAddressMasked: z.string().optional(),
    note: z.string().optional()
});
class MockOrderAdapter {
    // Mock 只验证订单意图和回复链路，模拟记录不得作为真实业务验收数据。
    orders = [
        {
            found: true,
            orderNo: 'TEST-ORDER-001',
            status: '已支付',
            amount: 128,
            itemName: '双人烤肉套餐',
            usageStatus: '未核销',
            createdAt: '2026-06-20T10:30:00+08:00',
            contactPhoneMasked: '138****8000'
        },
        {
            found: true,
            orderNo: 'yl_20260528YKBb13',
            status: '已完成',
            amount: 199,
            itemName: '门店测试套餐',
            usageStatus: '已核销',
            contactPhoneMasked: '139****9000'
        },
        {
            found: true,
            orderNo: 'yl_20260704D7Bm7',
            status: '清洗中',
            amount: 89,
            itemName: '任洗套餐',
            usageStatus: '未核销',
            pickupStatus: '已取件',
            deliveryStatus: '待送回',
            storeName: '测试门店 A',
            createdAt: '2026-07-04T14:20:00+08:00',
            contactPhoneMasked: '137****1234'
        }
    ];
    async queryBySearchKey(searchValue) {
        const normalized = searchValue.toLowerCase();
        return this.orders.filter((order) => (order.orderNo.toLowerCase() === normalized
            || order.contactPhoneMasked?.replace(/\*/g, '').includes(searchValue)));
    }
}
// 通用内部 HTTP Adapter，要求上游已经转换为统一订单结构。
// 公司原始接口字段未知时不能在这里猜测；当前真实后台请使用 legacy-admin 模式。
class HttpOrderAdapter {
    async queryBySearchKey(searchValue) {
        if (!env.ORDER_API_QUERY_URL_TEMPLATE?.includes('{orderNo}')) {
            throw new Error('ORDER_API_QUERY_URL_TEMPLATE 必须包含 {orderNo} 占位符');
        }
        const url = env.ORDER_API_QUERY_URL_TEMPLATE.replace('{orderNo}', encodeURIComponent(searchValue));
        const headers = { Accept: 'application/json' };
        if (env.ORDER_API_AUTH_HEADER && env.ORDER_API_AUTH_VALUE) {
            headers[env.ORDER_API_AUTH_HEADER] = env.ORDER_API_AUTH_VALUE;
        }
        const raw = await fetchJsonWithTimeout(url, { method: 'GET', headers }, env.ORDER_API_TIMEOUT_MS);
        const list = Array.isArray(raw) ? raw : [raw];
        return list.map((item) => orderResultSchema.parse(item));
    }
}
let adminRuntimeToken = '';
let adminLoginPromise = null;
// 迁移自已经跑通的 wecom-openclaw-gateway 订单后台逻辑。
// 后台接口即使鉴权失效也可能返回 HTTP 200，因此必须同时检查业务 code。
class LegacyAdminOrderAdapter {
    async queryBySearchKey(searchValue) {
        // 查询只读列表接口；401 时最多重新登录一次，避免失效 token 导致无限重试。
        if (!env.ADMIN_BASE_URL || !searchValue)
            return [];
        let token = adminRuntimeToken || env.ADMIN_TOKEN;
        if (!token && this.canAutoLogin())
            token = await this.login();
        let response = await this.requestOrders(searchValue, token);
        if (Number(response?.code) === 401 && this.canAutoLogin()) {
            token = await this.login(true);
            response = await this.requestOrders(searchValue, token);
        }
        const code = Number(response?.code);
        const ok = response?.success === true || code === 0 || code === 200;
        if (!ok) {
            const publicReason = code === 401 ? '订单系统授权无效' : '订单系统业务查询失败';
            throw new Error(`${publicReason}（业务码 ${response?.code ?? 'unknown'}）`);
        }
        const payload = response?.data ?? response?.result ?? {};
        const records = payload.records ?? payload.list ?? payload.items ?? payload.rows ?? [];
        if (!Array.isArray(records))
            return [];
        return records.map((order) => this.summarizeOrder(order));
    }
    async requestOrders(searchValue, token) {
        // 参数名来自已跑通后台配置，全部由环境变量控制，不在代码中猜测其他企业接口字段。
        const url = new URL(env.ADMIN_ORDER_LIST_PATH, ensureTrailingSlash(env.ADMIN_BASE_URL));
        url.searchParams.set(env.ADMIN_ORDER_PAGE_CURRENT_FIELD, String(env.ADMIN_ORDER_PAGE_CURRENT));
        url.searchParams.set(env.ADMIN_ORDER_PAGE_SIZE_FIELD, String(env.ADMIN_ORDER_PAGE_SIZE));
        url.searchParams.set(env.ADMIN_ORDER_SEARCH_KEY_FIELD, searchValue);
        url.searchParams.set('_', String(Date.now()));
        return fetchJsonWithTimeout(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                token,
                TenCode: env.ADMIN_TENCODE
            }
        }, 15000);
    }
    canAutoLogin() {
        return Boolean(env.ADMIN_BASE_URL && env.ADMIN_ACCOUNT && env.ADMIN_PASSWORD);
    }
    async login(force = false) {
        // 并发查询共享同一个登录 Promise，避免多个客户同时查单时重复登录触发后台风控。
        if (!force && adminRuntimeToken)
            return adminRuntimeToken;
        if (!force && env.ADMIN_TOKEN)
            return env.ADMIN_TOKEN;
        if (!this.canAutoLogin())
            throw new Error('订单后台自动登录账号未配置');
        if (adminLoginPromise)
            return adminLoginPromise;
        adminLoginPromise = (async () => {
            // 旧后台要求 SM2 C1C3C2 模式（cipherMode=1）加密密码，保持和已跑通网关完全一致。
            const encryptedPassword = sm2.doEncrypt(env.ADMIN_PASSWORD, ADMIN_SM2_PUBLIC_KEY, 1);
            const url = new URL(env.ADMIN_LOGIN_PATH, ensureTrailingSlash(env.ADMIN_BASE_URL));
            const response = await fetchJsonWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    TenCode: env.ADMIN_TENCODE
                },
                body: JSON.stringify({
                    account: env.ADMIN_ACCOUNT,
                    password: encryptedPassword,
                    validCode: '',
                    validCodeReqNo: ''
                })
            }, 15000);
            if (Number(response?.code) !== 200 || !response?.data) {
                throw new Error(`订单后台登录失败（业务码 ${response?.code ?? 'unknown'}）`);
            }
            adminRuntimeToken = String(response.data);
            return adminRuntimeToken;
        })();
        try {
            return await adminLoginPromise;
        }
        finally {
            adminLoginPromise = null;
        }
    }
    summarizeOrder(order) {
        // 原始订单先映射和脱敏，再交给 OpenClaw；模型永远不能看到完整姓名、电话和地址。
        const amountValue = order.payBalance ?? order.orderBalance;
        const amount = amountValue === undefined || amountValue === null || amountValue === ''
            ? undefined
            : Number(amountValue);
        return {
            found: true,
            orderNo: String(order.orderNo ?? order.order_no ?? order.orderSn ?? order.order_sn
                ?? order.sn ?? order.code ?? order.bizOrderNo ?? ''),
            status: stringOrUndefined(order.orderStatusName ?? order.statusName ?? order.orderStatus ?? order.status),
            orderSource: stringOrUndefined(order.orderTypeName ?? order.orderSourceName ?? order.sourceName),
            itemName: stringOrUndefined(order.goodsName ?? order.productName ?? order.packageName),
            amount: Number.isFinite(amount) ? amount : undefined,
            usageStatus: stringOrUndefined(order.verifyStatusName ?? order.useStatusName),
            pickupStatus: stringOrUndefined(order.driverPickStatusName ?? order.transferDriverPickStatusName),
            deliveryStatus: stringOrUndefined(order.driverSendStatusName ?? order.deliveryStatus ?? order.delivery_status),
            storeName: stringOrUndefined(order.storeName),
            createdAt: stringOrUndefined(order.createTime),
            paidAt: stringOrUndefined(order.payTime ?? order.paidAt ?? order.paymentTime),
            contactNameMasked: maskName(order.contactName ?? order.customerName ?? ''),
            contactPhoneMasked: maskPhone(order.contactPhone ?? order.storePhone ?? ''),
            deliveryAddressMasked: maskAddress(order.detailAddr ?? order.deliveryAddress ?? order.address ?? '')
        };
    }
}
export class OrderService {
    adapter;
    openClaw = new OpenClawClient();
    constructor() {
        // Adapter 模式由环境变量显式选择，未配置真实接口时回退 Mock，不能自动探测或编造端点。
        this.adapter = env.ORDER_ADAPTER_MODE === 'legacy-admin'
            ? new LegacyAdminOrderAdapter()
            : env.ORDER_ADAPTER_MODE === 'http'
                ? new HttpOrderAdapter()
                : new MockOrderAdapter();
    }
    isOrderQuery(message) {
        return ['订单', '查单', '查状态', '查进度', '物流', '核销状态', '付款状态', '支付状态', '单号', '取件码']
            .some((keyword) => message.includes(keyword));
    }
    extractOrderNo(message) {
        if (!this.isOrderQuery(message))
            return null;
        return this.extractOrderNoCandidate(message);
    }
    // 多轮查单时客户第二句通常只发送编号，因此候选提取不能强制当前句再次包含“订单”关键词。
    extractOrderNoCandidate(message) {
        const labeled = message.match(/(?:订单号|订单id|单号|订单编号|order\s*no\.?|order\s*id)[：:\s-]*([A-Za-z0-9_-]{6,32})/i)?.[1];
        if (labeled)
            return labeled;
        const candidates = message.match(/[A-Za-z0-9_-]{6,32}/g) ?? [];
        return candidates.find((candidate) => /[A-Za-z]/.test(candidate) && /\d/.test(candidate)) ?? null;
    }
    extractPhone(message) {
        if (!this.isOrderQuery(message))
            return null;
        return this.extractPhoneCandidate(message);
    }
    extractPhoneCandidate(message) {
        return message.match(/1[3-9]\d{9}/)?.[0] ?? null;
    }
    /**
     * 客服刚在要单号/手机号。口语句式较多（“需要订单号”“把单号发我”），不能只匹配“请提供订单号”。
     */
    isAwaitingOrderIdentifier(history) {
        return history.slice(-6).some((item) => {
            if (item.role !== 'assistant')
                return false;
            const text = String(item.content ?? '');
            return /(提供|发送|补充|确认|需要|麻烦|发给|发我|告诉我?).{0,24}(订单号|订单编号|完整单号|单号|下单手机号|手机号|取件码)/.test(text)
                || /(订单号|订单编号|完整单号|单号|取件码).{0,20}(发我|发给|发送|提供|补充|发一下)/.test(text);
        });
    }
    /**
     * 近几轮已经在聊订单（客户或客服任一方提到），允许下一句纯单号进入订单路由。
     * 避免人设改写后索要话术变体导致 awaiting 判假、纯单号误走知识库。
     */
    hasRecentOrderContext(history) {
        return history.slice(-8).some((item) => /(订单|查单|单号|取件码|核销|洗好了吗|付款状态|支付状态)/.test(String(item.content ?? '')));
    }
    async queryOrder(orderNo) {
        // 返回统一的 found=false 结构而不是让模型根据空结果猜测订单状态。
        const orders = await this.adapter.queryBySearchKey(orderNo);
        const normalized = orderNo.toLowerCase();
        return orders.find((order) => order.orderNo.toLowerCase() === normalized) ?? {
            found: false,
            orderNo,
            note: '未查询到该订单'
        };
    }
    async queryOrdersByPhone(phone) {
        // 手机号只作为公司系统只读查询条件，返回结果必须在后续转换中脱敏。
        return this.adapter.queryBySearchKey(phone);
    }
    // 给 RPA watcher 使用的受控工具入口：OpenClaw 选择动作，后端校验并执行真实只读查询。
    // 订单事实仍由 Adapter 提供，模型只能组织脱敏结果，不能自行调用任意接口。
    async queryMessage(message) {
        const highRiskKeywords = ['退款', '投诉', '差评', '赔偿', '食品安全', '吃坏', '过敏', '报警', '12315', '工商', '法律', '律师', '威胁'];
        if (highRiskKeywords.some((keyword) => message.includes(keyword))) {
            return {
                matched: true,
                needHuman: true,
                answer: '这个我帮您转人工确认一下。'
            };
        }
        const action = await this.openClaw.analyzeOrderAction(message);
        if (action.action === 'handoff') {
            return { matched: true, needHuman: true, answer: '这个我帮您转人工确认一下。' };
        }
        if (action.action === 'none')
            return { matched: false };
        if (action.action === 'query_order_by_no') {
            const orderNo = this.validateOrderNo(action.orderNo, message);
            if (!orderNo) {
                return {
                    matched: true,
                    needHuman: false,
                    queryType: 'missing',
                    answer: '您好，查询订单请提供订单号，我这边帮您核实。'
                };
            }
            const order = await this.queryOrder(orderNo);
            if (!order.found) {
                return {
                    matched: true,
                    needHuman: false,
                    queryType: 'orderNo',
                    answer: `您好，我暂时没有查到订单 ${orderNo} 的明确信息，请您确认订单号是否正确。`
                };
            }
            const details = [
                `帮您查到订单 ${order.orderNo}`,
                `当前状态是${order.status || '处理中'}`,
                order.orderSource ? `订单来源是${order.orderSource}` : '',
                order.itemName ? `商品或套餐是${order.itemName}` : '',
                order.amount !== undefined ? `实付金额是${order.amount}元` : '',
                order.storeName ? `门店是${order.storeName}` : '',
                order.pickupStatus ? `取件状态是${order.pickupStatus}` : '',
                order.deliveryStatus ? `配送状态是${order.deliveryStatus}` : '',
                order.usageStatus ? `核销状态是${order.usageStatus}` : '',
                order.createdAt ? `下单时间是${order.createdAt}` : '',
                order.paidAt ? `支付时间是${order.paidAt}` : '',
                order.contactNameMasked ? `联系人是${order.contactNameMasked}` : '',
                order.contactPhoneMasked ? `联系电话是${order.contactPhoneMasked}` : '',
                order.deliveryAddressMasked ? `配送地址是${order.deliveryAddressMasked}` : ''
            ].filter(Boolean);
            const fallbackAnswer = `${details.join('，')}。`;
            const modelAnswer = await this.openClaw.generateOrderReply(message, this.toRagHit(order).content);
            return {
                matched: true,
                needHuman: false,
                queryType: 'orderNo',
                answer: modelAnswer || fallbackAnswer
            };
        }
        if (action.action === 'query_orders_by_phone') {
            const phone = this.validatePhone(action.phone, message);
            if (!phone) {
                return {
                    matched: true,
                    needHuman: false,
                    queryType: 'missing',
                    answer: '您好，请提供完整的下单手机号，我这边帮您核实。'
                };
            }
            const orders = await this.queryOrdersByPhone(phone);
            const fallbackAnswer = orders.length > 0
                ? `您好，帮您查到 ${orders.length} 个相关订单，请您补充准确的订单号，我帮您继续核实。`
                : '您好，暂时没有查询到该手机号关联的订单，请您核对手机号或提供订单号。';
            const modelAnswer = await this.openClaw.generateOrderReply(message, this.toPhoneRagHit(phone, orders).content);
            return {
                matched: true,
                needHuman: false,
                queryType: 'phone',
                answer: modelAnswer || fallbackAnswer
            };
        }
        return {
            matched: true,
            needHuman: false,
            queryType: 'missing',
            answer: '您好，查询订单请提供订单号或下单手机号，我这边帮您核实。'
        };
    }
    validateOrderNo(value, message) {
        if (!value || !/^[A-Za-z0-9_-]{6,64}$/.test(value))
            return null;
        return message.toLowerCase().includes(value.toLowerCase()) ? value : null;
    }
    validatePhone(value, message) {
        if (!value || !/^1[3-9]\d{9}$/.test(value))
            return null;
        return message.includes(value) ? value : null;
    }
    toRagHit(result) {
        const lines = result.found
            ? [
                `订单号：${result.orderNo}`,
                `订单状态：${result.status ?? '未知'}`,
                `订单来源：${result.orderSource ?? '未知'}`,
                `商品/套餐：${result.itemName ?? '未知'}`,
                `金额：${result.amount === undefined ? '未知' : `${result.amount} 元`}`,
                `核销状态：${result.usageStatus ?? '未知'}`,
                `取件状态：${result.pickupStatus ?? '未知'}`,
                `配送状态：${result.deliveryStatus ?? '未知'}`,
                `门店：${result.storeName ?? '未知'}`,
                `下单时间：${result.createdAt ?? '未知'}`,
                `支付时间：${result.paidAt ?? '未知'}`,
                `联系人：${result.contactNameMasked ?? '已脱敏'}`,
                `联系电话：${result.contactPhoneMasked ?? '已脱敏'}`,
                `配送地址：${result.deliveryAddressMasked ?? '已脱敏'}`
            ]
            : [`订单号：${result.orderNo}`, '查询结果：未查询到该订单'];
        return createOrderRagHit(result.orderNo, lines.join('\n'));
    }
    toPhoneRagHit(phone, orders) {
        const maskedPhone = maskPhone(phone);
        const content = orders.length > 0
            ? `手机号 ${maskedPhone} 共查询到 ${orders.length} 个订单：\n${orders.slice(0, 5).map((order) => (`- ${order.orderNo}，${order.status ?? '状态未知'}，${order.storeName ?? '门店未知'}`)).join('\n')}\n请引导客户提供准确订单号后继续核实，不要猜测具体订单。`
            : `手机号 ${maskedPhone} 未查询到关联订单，请客户核对手机号或提供订单号。`;
        return createOrderRagHit(`phone:${maskedPhone}`, content);
    }
}
function createOrderRagHit(id, content) {
    return {
        id: `order-system:${id}`,
        content: `公司订单系统查询结果（只读）：\n${content}`,
        metadata: { source: 'company-order-system', trusted: true },
        score: 1
    };
}
async function fetchJsonWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) {
            // 不把后台错误正文写入日志，避免响应中可能包含的内部字段或客户信息泄露。
            throw new Error(`订单接口 HTTP ${response.status}`);
        }
        return response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
function stringOrUndefined(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    return String(value);
}
function maskPhone(value) {
    return String(value ?? '').replace(/1[3-9]\d{9}/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`);
}
function maskName(value) {
    const name = String(value ?? '').trim();
    if (!name)
        return undefined;
    return name.length === 1 ? '*' : `${name.slice(0, 1)}${'*'.repeat(Math.min(name.length - 1, 3))}`;
}
function maskAddress(value) {
    const address = String(value ?? '').trim();
    if (!address)
        return undefined;
    // 地址只保留到区域或道路级别，门牌号和房间号统一隐藏，避免模型接触完整个人地址。
    return address
        .replace(/\d+(?:号|栋|幢|单元|室|层)/g, '**')
        .replace(/(路|街|道|巷)\d+.*/, '$1**');
}
