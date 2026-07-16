// @ts-nocheck
/**
 * @file apps/api/src/config/env.ts
 * @module API 入口与基础设施
 * @description UTF-8 读取根 .env 并校验 API 所需环境变量。
 * @see 联动关注：.env.example 和各 Service。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');
// workspace 命令会在 apps/api 下执行，不能依赖 dotenv 的默认查找路径。
// 这里显式读取项目根目录 .env，并固定 UTF-8，避免 Windows 中文配置出现乱码。
// override:true 确保重启/热重载后以项目 .env 为准，避免旧 process.env 里的 false 把自动发送开关卡死。
config({
    path: resolve(runtimeRoot, '.env'),
    encoding: 'utf8',
    override: true
});
const booleanString = z.preprocess((value) => {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized))
            return true;
        if (['false', '0', 'no', 'off', ''].includes(normalized))
            return false;
    }
    return value;
}, z.boolean());
// 使用 zod 校验环境变量，避免运行到一半才发现配置缺失。
const envSchema = z.object({
    NODE_ENV: z.string().default('development'),
    API_PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    // LLM：默认直连 Agnes / OpenAI 兼容接口；openclaw 仅作可选本机网关。
    LLM_PROVIDER: z.enum(['agnes', 'agenes', 'qianwen', 'dashscope', 'openai-compatible', 'custom', 'openclaw']).default('agnes'),
    LLM_BASE_URL: z.string().optional().default(''),
    LLM_API_KEY: z.string().optional().default(''),
    LLM_MODEL: z.string().optional().default(''),
    // Agnes 官方拼写；兼容历史 .env.example 里的 AGENES_*。
    AGNES_API_URL: z.string().optional().default(''),
    AGNES_API_KEY: z.string().optional().default(''),
    AGNES_MODEL: z.string().optional().default('agnes-2.0-flash'),
    AGENES_API_URL: z.string().optional().default(''),
    AGENES_API_KEY: z.string().optional().default(''),
    OPENCLAW_GATEWAY_URL: z.string().optional().default('http://127.0.0.1:18789'),
    OPENCLAW_TOKEN: z.string().optional().default(''),
    OPENCLAW_PORTABLE_ROOT: z.string().optional().default(''),
    OPENCLAW_TOKEN_FILE: z.string().optional().default(''),
    OPENCLAW_AUTO_START: booleanString.default(false),
    OPENCLAW_MODEL: z.string().default('openclaw/default'),
    OPENCLAW_AGENT_ID: z.string().default('main'),
    OPENCLAW_CHAT_ENDPOINT: z.string().default('/v1/chat/completions'),
    OPENCLAW_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    EMBEDDING_BASE_URL: z.string().min(1),
    EMBEDDING_API_KEY: z.string().min(1),
    EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    EMBEDDING_DIM: z.coerce.number().default(1536),
    RAG_SERVICE_URL: z.string().url().default('http://127.0.0.1:8787'),
    RAG_API_KEY: z.string().min(1).default('local-dev-key'),
    RAG_HARD_FLOOR: z.coerce.number().min(0).max(1).default(0.35),
    WECOM_CORP_ID: z.string().optional().default(''),
    WECOM_SECRET: z.string().optional().default(''),
    WECOM_TOKEN: z.string().optional().default(''),
    WECOM_AES_KEY: z.string().optional().default(''),
    WECOM_AGENT_ID: z.coerce.number().optional().default(0),
    // 公司订单系统通过 Adapter 接入。默认 mock，真实 URL 和字段必须以公司接口文档为准。
    ORDER_ADAPTER_MODE: z.enum(['mock', 'http', 'legacy-admin']).default('mock'),
    ORDER_API_QUERY_URL_TEMPLATE: z.string().optional().default(''),
    ORDER_API_AUTH_HEADER: z.string().optional().default(''),
    ORDER_API_AUTH_VALUE: z.string().optional().default(''),
    ORDER_API_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    ADMIN_BASE_URL: z.string().optional().default(''),
    ADMIN_LOGIN_PATH: z.string().default('/api/auth/b/doLogin'),
    ADMIN_ORDER_LIST_PATH: z.string().default('/api/biz/cxorderlaundry/page'),
    ADMIN_TOKEN: z.string().optional().default(''),
    ADMIN_TENCODE: z.string().optional().default(''),
    ADMIN_ACCOUNT: z.string().optional().default(''),
    ADMIN_PASSWORD: z.string().optional().default(''),
    ADMIN_ORDER_SEARCH_KEY_FIELD: z.string().default('searchKey'),
    ADMIN_ORDER_PAGE_CURRENT_FIELD: z.string().default('current'),
    ADMIN_ORDER_PAGE_SIZE_FIELD: z.string().default('size'),
    ADMIN_ORDER_PAGE_CURRENT: z.coerce.number().int().positive().default(1),
    ADMIN_ORDER_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(10),
    // 不能使用 z.coerce.boolean()，因为字符串 "false" 会被 Boolean("false") 转成 true。
    // 自动发送开关必须严格解析，避免测试阶段误发消息。
    AUTO_REPLY_ENABLED: booleanString.default(false),
    RPA_AUTO_SEND_ENABLED: booleanString.default(false),
    // 真实美团灰度时只允许指定客户进入 RPA 链路，避免线上测试误处理非测试顾客。
    MEITUAN_RPA_ALLOWED_CUSTOMERS: z.string().optional().default(''),
    // 真实抖音来客灰度时只允许指定客户进入 RPA 链路；留空表示不过滤。
    DOUYIN_RPA_ALLOWED_CUSTOMERS: z.string().optional().default('')
});
const parsedEnv = envSchema.parse(process.env);

/**
 * 便携包固定布局：包根目录下的 openclaw/。
 * 未配置环境变量时按相对路径自动发现，避免交付后还要手写绝对路径。
 * 开发机若 OpenClaw 在项目外，仍可用 OPENCLAW_PORTABLE_ROOT 覆盖。
 */
function resolveOpenClawPortableRoot() {
    const configured = String(parsedEnv.OPENCLAW_PORTABLE_ROOT ?? '').trim();
    if (configured) {
        return isAbsolute(configured) ? configured : resolve(runtimeRoot, configured);
    }
    const bundled = resolve(runtimeRoot, 'openclaw');
    if (existsSync(resolve(bundled, 'Start-OpenClaw.ps1')))
        return bundled;
    return '';
}

function resolveOpenClawTokenFile(portableRoot) {
    const configured = String(parsedEnv.OPENCLAW_TOKEN_FILE ?? '').trim();
    if (configured)
        return isAbsolute(configured) ? configured : resolve(runtimeRoot, configured);
    if (!portableRoot)
        return '';
    return resolve(portableRoot, 'data', '.openclaw', 'gateway-token.txt');
}

function resolveOpenClawToken(tokenFile) {
    // 便携版会自行生成并维护 token；项目只读取，不复制、不修改，也不把内容写入日志。
    if (tokenFile && existsSync(tokenFile))
        return readFileSync(tokenFile, 'utf-8').trim();
    return parsedEnv.OPENCLAW_TOKEN;
}

const openClawPortableRoot = resolveOpenClawPortableRoot();
const openClawTokenFile = resolveOpenClawTokenFile(openClawPortableRoot);
const openClawToken = resolveOpenClawToken(openClawTokenFile);

/**
 * 解析实际 chat completions 调用目标。
 * agnes：直连 Agnes；openai-compatible：直连 LLM_BASE_URL；openclaw：本机网关（可选）。
 */
function resolveLlmTarget() {
    const providerRaw = String(parsedEnv.LLM_PROVIDER || 'agnes').toLowerCase();
    const provider = providerRaw === 'agenes' ? 'agnes' : providerRaw;
    const agnesKey = String(parsedEnv.AGNES_API_KEY || parsedEnv.AGENES_API_KEY || '').trim();
    const agnesUrl = String(parsedEnv.AGNES_API_URL || parsedEnv.AGENES_API_URL || '').trim();
    const agnesModel = String(parsedEnv.AGNES_MODEL || parsedEnv.LLM_MODEL || 'agnes-2.0-flash').trim();
    const llmKey = String(parsedEnv.LLM_API_KEY || '').trim();
    const llmBase = String(parsedEnv.LLM_BASE_URL || '').trim().replace(/\/$/, '');
    const llmModel = String(parsedEnv.LLM_MODEL || '').trim();

    if (provider === 'agnes') {
        const url = agnesUrl
            || (llmBase ? (llmBase.endsWith('/chat/completions') ? llmBase : `${llmBase}/chat/completions`) : '');
        return {
            provider: 'agnes',
            url,
            apiKey: agnesKey || llmKey,
            model: agnesModel || 'agnes-2.0-flash',
            requiresLocalGateway: false
        };
    }
    if (provider === 'qianwen' || provider === 'dashscope') {
        const base = llmBase || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        const url = base.endsWith('/chat/completions') ? base : `${base.replace(/\/$/, '')}/chat/completions`;
        return {
            provider: 'qianwen',
            url,
            apiKey: llmKey || agnesKey,
            model: llmModel || 'qwen-plus',
            requiresLocalGateway: false
        };
    }
    if (provider === 'openai-compatible' || provider === 'custom') {
        const url = llmBase.endsWith('/chat/completions')
            ? llmBase
            : `${llmBase}/chat/completions`;
        return {
            provider: 'custom',
            url,
            apiKey: llmKey || agnesKey,
            model: llmModel || agnesModel || '',
            requiresLocalGateway: false
        };
    }
    // openclaw：继续走本机网关。
    const endpoint = String(parsedEnv.OPENCLAW_CHAT_ENDPOINT || '/v1/chat/completions')
        .replace('{agentId}', parsedEnv.OPENCLAW_AGENT_ID || 'main');
    const gateway = String(parsedEnv.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
    return {
        provider: 'openclaw',
        url: `${gateway}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`,
        apiKey: openClawToken,
        model: String(parsedEnv.OPENCLAW_MODEL || llmModel || 'openclaw/default'),
        requiresLocalGateway: true
    };
}

const llmTarget = resolveLlmTarget();
export const env = {
    ...parsedEnv,
    LLM_PROVIDER: llmTarget.provider,
    OPENCLAW_PORTABLE_ROOT: openClawPortableRoot,
    OPENCLAW_TOKEN_FILE: openClawTokenFile,
    OPENCLAW_TOKEN: openClawToken,
    LLM_CHAT_URL: llmTarget.url,
    LLM_CHAT_API_KEY: llmTarget.apiKey,
    LLM_CHAT_MODEL: llmTarget.model,
    LLM_REQUIRES_LOCAL_GATEWAY: llmTarget.requiresLocalGateway
};
