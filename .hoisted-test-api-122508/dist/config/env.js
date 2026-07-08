// @ts-nocheck
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
config({
    path: resolve(runtimeRoot, '.env'),
    encoding: 'utf8'
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
    OPENCLAW_GATEWAY_URL: z.string().min(1),
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
    RPA_AUTO_SEND_ENABLED: booleanString.default(false)
});
const parsedEnv = envSchema.parse(process.env);
function resolveOpenClawToken() {
    if (!parsedEnv.OPENCLAW_TOKEN_FILE)
        return parsedEnv.OPENCLAW_TOKEN;
    const tokenPath = isAbsolute(parsedEnv.OPENCLAW_TOKEN_FILE)
        ? parsedEnv.OPENCLAW_TOKEN_FILE
        : resolve(runtimeRoot, parsedEnv.OPENCLAW_TOKEN_FILE);
    // 便携版会自行生成并维护 token；项目只读取，不复制、不修改，也不把内容写入日志。
    if (!existsSync(tokenPath))
        return parsedEnv.OPENCLAW_TOKEN;
    return readFileSync(tokenPath, 'utf-8').trim();
}
export const env = {
    ...parsedEnv,
    OPENCLAW_TOKEN: resolveOpenClawToken()
};
