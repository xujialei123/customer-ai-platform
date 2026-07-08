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
config({
    path: resolve(runtimeRoot, '.env'),
    encoding: 'utf8',
    // dev:all 父进程可能保留修改前的环境变量；RAG 配置应以当前项目 .env 为准，避免热重载继续使用旧模型。
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
const envSchema = z.object({
    NODE_ENV: z.string().default('development'),
    RAG_SERVICE_PORT: z.coerce.number().default(8787),
    RAG_API_KEY: z.string().default('local-dev-key'),
    DATABASE_URL: z.string().default(''),
    VECTOR_STORE: z.enum(['memory', 'pgvector']).default('memory'),
    VECTOR_DIM: z.coerce.number().default(1536),
    EMBEDDING_PROVIDER: z.string().default('mock'),
    EMBEDDING_BASE_URL: z.string().default('https://api.openai.com/v1'),
    EMBEDDING_API_KEY: z.string().default(''),
    EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    LLM_PROVIDER: z.enum(['mock', 'openai-compatible', 'agenes', 'openclaw']).default('mock'),
    LLM_BASE_URL: z.string().default('https://api.openai.com/v1'),
    LLM_API_KEY: z.string().default(''),
    LLM_MODEL: z.string().default('gpt-4.1-mini'),
    OPENCLAW_GATEWAY_URL: z.string().default('http://127.0.0.1:18789'),
    OPENCLAW_TOKEN: z.string().optional().default(''),
    OPENCLAW_TOKEN_FILE: z.string().optional().default(''),
    OPENCLAW_MODEL: z.string().default('openclaw/default'),
    OPENCLAW_CHAT_ENDPOINT: z.string().default('/v1/chat/completions'),
    OPENCLAW_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    AGENES_API_URL: z.string().default('http://127.0.0.1:18888/chat'),
    AGENES_API_KEY: z.string().default(''),
    RAG_TOP_K: z.coerce.number().default(5),
    RAG_SCORE_THRESHOLD: z.coerce.number().default(0.72),
    RAG_HARD_FLOOR: z.coerce.number().min(0).max(1).default(0.35),
    RAG_MAX_CONTEXT_CHARS: z.coerce.number().default(6000),
    RAG_HISTORY_TURNS: z.coerce.number().default(6),
    RAG_USE_RERANK: booleanString.default(false),
    UPLOAD_DIR: z.string().default('./uploads'),
    MAX_FILE_SIZE_MB: z.coerce.number().default(50),
    SUPPORTED_FILE_TYPES: z.string().default('txt,md,pdf,docx,csv,xlsx'),
    RPA_DRY_RUN: booleanString.default(true),
    RPA_MAX_REPLY_CHARS: z.coerce.number().default(500)
});
const parsedEnv = envSchema.parse(process.env);
function resolveOpenClawToken() {
    if (!parsedEnv.OPENCLAW_TOKEN_FILE)
        return parsedEnv.OPENCLAW_TOKEN;
    const tokenPath = isAbsolute(parsedEnv.OPENCLAW_TOKEN_FILE)
        ? parsedEnv.OPENCLAW_TOKEN_FILE
        : resolve(runtimeRoot, parsedEnv.OPENCLAW_TOKEN_FILE);
    if (!existsSync(tokenPath))
        return parsedEnv.OPENCLAW_TOKEN;
    return readFileSync(tokenPath, 'utf-8').trim();
}
export const env = {
    ...parsedEnv,
    OPENCLAW_TOKEN: resolveOpenClawToken()
};
export function safeEnvView() {
    return {
        ...env,
        RAG_API_KEY: env.RAG_API_KEY ? '***' : '',
        EMBEDDING_API_KEY: env.EMBEDDING_API_KEY ? '***' : '',
        LLM_API_KEY: env.LLM_API_KEY ? '***' : '',
        AGENES_API_KEY: env.AGENES_API_KEY ? '***' : ''
    };
}
