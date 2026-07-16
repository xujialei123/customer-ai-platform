// @ts-nocheck
/**
 * @file apps/api/src/config/model-config.ts
 * @module API 入口与基础设施
 * @description 配置页可编辑的客服 LLM 与 Embedding；热生效并同步 .env。
 * @see 联动关注：guide 配置页、openclaw.service、rag-service runtime-config。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from './env.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');
const localConfigPath = resolve(runtimeRoot, 'config/model.local.json');
const envFilePath = resolve(runtimeRoot, '.env');

export const AGNES_DEFAULT_CHAT_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';
export const AGNES_DEFAULT_MODEL = 'agnes-2.0-flash';
/** 千问云 OpenAI 兼容模式，见 https://platform.qianwenai.com/docs/developer-guides/getting-started/first-api-call */
export const QIANWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const QIANWEN_DEFAULT_MODEL = 'qwen-plus';
export const QIANWEN_MODEL_OPTIONS = [
    'qwen-turbo',
    'qwen-plus',
    'qwen-flash',
    'qwen3.7-plus'
];

const PLACEHOLDER_KEYS = new Set([
    '',
    'replace-me',
    'your_openclaw_token',
    'your_llm_key',
    'your_agenes_key',
    'your_agnes_key',
    'your_embedding_key',
    'your_dashscope_key'
]);

const llmSchema = z.object({
    provider: z.enum(['agnes', 'qianwen', 'custom', 'openclaw']),
    baseUrl: z.string().optional().default(''),
    apiKey: z.string().optional().default(''),
    model: z.string().optional().default('')
});

const embeddingSchema = z.object({
    baseUrl: z.string().optional().default(''),
    apiKey: z.string().optional().default(''),
    model: z.string().optional().default('')
});

const fileSchema = z.object({
    llm: llmSchema.optional(),
    embedding: embeddingSchema.optional()
});

/** @type {{ llm?: object, embedding?: object } | null} */
let memoryOverride = null;
let bootstrapped = false;

function maskSecret(value) {
    const text = String(value || '');
    if (!text)
        return '';
    if (text.length <= 8)
        return '****';
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function isUsableKey(value) {
    const key = String(value || '').trim();
    return Boolean(key) && !PLACEHOLDER_KEYS.has(key);
}

/** 兼容用户填根路径 `/v1` 或完整 `/v1/chat/completions`。 */
export function toChatCompletionsUrl(baseUrl) {
    const url = String(baseUrl || '').trim().replace(/\/$/, '');
    if (!url)
        return '';
    if (url.endsWith('/chat/completions'))
        return url;
    return `${url}/chat/completions`;
}

function toEmbeddingsBaseUrl(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/$/, '');
}

async function readLocalFile() {
    try {
        const text = await readFile(localConfigPath, 'utf-8');
        if (!text.trim())
            return {};
        return fileSchema.parse(JSON.parse(text));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return {};
        throw error;
    }
}

async function writeLocalFile(value) {
    await mkdir(dirname(localConfigPath), { recursive: true });
    await writeFile(localConfigPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/** 只改模型相关键，不动其它 .env 行。 */
async function syncEnvFile(updates) {
    let text = '';
    try {
        text = await readFile(envFilePath, 'utf-8');
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const lines = text ? text.split(/\r?\n/) : [];
    const seen = new Set();
    const next = lines.map((line) => {
        const match = line.match(/^([A-Z0-9_]+)\s*=/);
        if (!match)
            return line;
        const key = match[1];
        if (!(key in updates))
            return line;
        seen.add(key);
        return `${key}=${updates[key]}`;
    });
    for (const [key, value] of Object.entries(updates)) {
        if (!seen.has(key))
            next.push(`${key}=${value}`);
    }
    await writeFile(envFilePath, `${next.join('\n').replace(/\n*$/, '\n')}`, 'utf-8');
}

function envLlmFallback() {
    const raw = String(env.LLM_PROVIDER || 'agnes').toLowerCase();
    if (raw === 'openclaw') {
        return {
            provider: 'openclaw',
            baseUrl: String(env.LLM_CHAT_URL || env.OPENCLAW_GATEWAY_URL || '').replace(/\/$/, ''),
            apiKey: String(env.LLM_CHAT_API_KEY || env.OPENCLAW_TOKEN || ''),
            model: String(env.LLM_CHAT_MODEL || env.OPENCLAW_MODEL || 'openclaw/default')
        };
    }
    if (raw === 'qianwen' || raw === 'dashscope') {
        const chatUrl = String(env.LLM_CHAT_URL || '').trim();
        const base = chatUrl || String(env.LLM_BASE_URL || '').trim() || QIANWEN_DEFAULT_BASE_URL;
        return {
            provider: 'qianwen',
            baseUrl: base,
            apiKey: String(env.LLM_CHAT_API_KEY || env.LLM_API_KEY || ''),
            model: String(env.LLM_CHAT_MODEL || env.LLM_MODEL || QIANWEN_DEFAULT_MODEL)
        };
    }
    if (raw === 'openai-compatible' || raw === 'custom') {
        const chatUrl = String(env.LLM_CHAT_URL || '').trim();
        const base = chatUrl || String(env.LLM_BASE_URL || '').trim();
        return {
            provider: 'custom',
            baseUrl: base,
            apiKey: String(env.LLM_CHAT_API_KEY || env.LLM_API_KEY || ''),
            model: String(env.LLM_CHAT_MODEL || env.LLM_MODEL || '')
        };
    }
    return {
        provider: 'agnes',
        baseUrl: String(env.LLM_CHAT_URL || env.AGNES_API_URL || AGNES_DEFAULT_CHAT_URL),
        apiKey: String(env.LLM_CHAT_API_KEY || env.AGNES_API_KEY || env.LLM_API_KEY || ''),
        model: String(env.LLM_CHAT_MODEL || env.AGNES_MODEL || AGNES_DEFAULT_MODEL)
    };
}

function envEmbeddingFallback() {
    return {
        baseUrl: String(env.EMBEDDING_BASE_URL || ''),
        apiKey: String(env.EMBEDDING_API_KEY || ''),
        model: String(env.EMBEDDING_MODEL || '')
    };
}

async function ensureBootstrapped() {
    if (bootstrapped)
        return;
    bootstrapped = true;
    if (memoryOverride)
        return;
    const local = await readLocalFile();
    if (local.llm || local.embedding)
        memoryOverride = local;
}

/** 当前生效的 LLM 调用目标（热配置优先）。 */
export async function getActiveLlmTarget() {
    await ensureBootstrapped();
    const stored = memoryOverride?.llm || envLlmFallback();
    const providerRaw = stored.provider === 'openai-compatible' ? 'custom'
        : (stored.provider === 'dashscope' ? 'qianwen' : stored.provider);
    const provider = providerRaw;
    let baseUrl = String(stored.baseUrl || '').trim();
    let model = String(stored.model || '').trim();
    const apiKey = String(stored.apiKey || '').trim();

    if (provider === 'agnes') {
        baseUrl = baseUrl || AGNES_DEFAULT_CHAT_URL;
        model = model || AGNES_DEFAULT_MODEL;
    }
    if (provider === 'qianwen') {
        baseUrl = baseUrl || QIANWEN_DEFAULT_BASE_URL;
        model = model || QIANWEN_DEFAULT_MODEL;
    }
    if (provider === 'openclaw') {
        const endpoint = String(env.OPENCLAW_CHAT_ENDPOINT || '/v1/chat/completions')
            .replace('{agentId}', env.OPENCLAW_AGENT_ID || 'main');
        const gateway = String(env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
        const chatUrl = baseUrl.includes('/chat/completions')
            ? toChatCompletionsUrl(baseUrl)
            : `${gateway}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
        return {
            provider: 'openclaw',
            baseUrl: chatUrl,
            chatUrl,
            apiKey: apiKey || String(env.OPENCLAW_TOKEN || ''),
            model: model || 'openclaw/default',
            requiresLocalGateway: true,
            configured: isUsableKey(apiKey || env.OPENCLAW_TOKEN)
        };
    }

    const chatUrl = toChatCompletionsUrl(baseUrl);
    return {
        provider,
        baseUrl,
        chatUrl,
        apiKey,
        model,
        requiresLocalGateway: false,
        configured: Boolean(chatUrl) && isUsableKey(apiKey)
    };
}

export async function getActiveEmbeddingTarget() {
    await ensureBootstrapped();
    const stored = memoryOverride?.embedding || envEmbeddingFallback();
    const baseUrl = toEmbeddingsBaseUrl(stored.baseUrl);
    const apiKey = String(stored.apiKey || '').trim();
    const model = String(stored.model || '').trim();
    return {
        baseUrl,
        apiKey,
        model,
        configured: Boolean(baseUrl) && isUsableKey(apiKey) && Boolean(model)
    };
}

export async function getPublicModelConfig() {
    const llm = await getActiveLlmTarget();
    const embedding = await getActiveEmbeddingTarget();
    return {
        llm: {
            provider: llm.provider,
            baseUrl: llm.baseUrl,
            model: llm.model,
            apiKeyMasked: maskSecret(llm.apiKey),
            hasApiKey: isUsableKey(llm.apiKey),
            chatUrl: llm.chatUrl,
            requiresLocalGateway: llm.requiresLocalGateway,
            configured: llm.configured
        },
        embedding: {
            baseUrl: embedding.baseUrl,
            model: embedding.model,
            apiKeyMasked: maskSecret(embedding.apiKey),
            hasApiKey: isUsableKey(embedding.apiKey),
            configured: embedding.configured,
            dim: env.EMBEDDING_DIM
        },
        presets: {
            agnes: {
                id: 'agnes',
                label: 'Agnes',
                baseUrl: AGNES_DEFAULT_CHAT_URL,
                model: AGNES_DEFAULT_MODEL
            },
            qianwen: {
                id: 'qianwen',
                label: '千问（DashScope）',
                baseUrl: QIANWEN_DEFAULT_BASE_URL,
                model: QIANWEN_DEFAULT_MODEL,
                models: QIANWEN_MODEL_OPTIONS
            },
            custom: {
                id: 'custom',
                label: '自定义（OpenAI 兼容）',
                baseUrl: '',
                model: ''
            }
        }
    };
}

async function notifyRagEmbedding(embedding) {
    const ragUrl = String(env.RAG_SERVICE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
    try {
        const response = await fetch(`${ragUrl}/admin/runtime-config`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'x-api-key': env.RAG_API_KEY
            },
            body: JSON.stringify({ embedding }),
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) {
            const body = await response.text();
            return { ok: false, error: `RAG HTTP ${response.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** 更新客服 LLM。apiKey 为空表示保持原密钥。 */
export async function updateLlmConfig(patch) {
    await ensureBootstrapped();
    const current = await getActiveLlmTarget();
    const parsed = llmSchema.parse({
        provider: patch?.provider === 'dashscope' ? 'qianwen' : (patch?.provider ?? current.provider),
        baseUrl: patch?.baseUrl ?? current.baseUrl,
        apiKey: patch?.apiKey === undefined || patch?.apiKey === null || String(patch.apiKey).trim() === ''
            ? current.apiKey
            : String(patch.apiKey).trim(),
        model: patch?.model ?? current.model
    });

    const next = { ...parsed };
    if (next.provider === 'agnes') {
        next.baseUrl = String(next.baseUrl || AGNES_DEFAULT_CHAT_URL).trim() || AGNES_DEFAULT_CHAT_URL;
        next.model = String(next.model || AGNES_DEFAULT_MODEL).trim() || AGNES_DEFAULT_MODEL;
    }
    if (next.provider === 'qianwen') {
        next.baseUrl = String(next.baseUrl || QIANWEN_DEFAULT_BASE_URL).trim() || QIANWEN_DEFAULT_BASE_URL;
        next.model = String(next.model || QIANWEN_DEFAULT_MODEL).trim() || QIANWEN_DEFAULT_MODEL;
    }
    if (next.provider === 'custom' && !String(next.baseUrl || '').trim())
        throw new Error('自定义模式必须填写 Base URL');
    if (next.provider === 'custom' && !String(next.model || '').trim())
        throw new Error('自定义模式必须填写 Model');
    if (!isUsableKey(next.apiKey) && next.provider !== 'openclaw')
        throw new Error('请填写有效的 API Key');

    const embedding = memoryOverride?.embedding || envEmbeddingFallback();
    memoryOverride = { llm: next, embedding };
    await writeLocalFile(memoryOverride);

    const chatUrl = next.provider === 'openclaw'
        ? (await getActiveLlmTarget()).chatUrl
        : toChatCompletionsUrl(next.baseUrl);
    const envProvider = next.provider === 'custom' ? 'openai-compatible' : next.provider;
    const updates = {
        LLM_PROVIDER: envProvider,
        LLM_BASE_URL: (next.provider === 'custom' || next.provider === 'qianwen')
            ? String(next.baseUrl || '').replace(/\/chat\/completions$/, '')
            : '',
        LLM_API_KEY: (next.provider === 'custom' || next.provider === 'qianwen') ? next.apiKey : '',
        LLM_MODEL: next.model
    };
    if (next.provider === 'agnes') {
        updates.AGNES_API_URL = chatUrl;
        updates.AGNES_API_KEY = next.apiKey;
        updates.AGNES_MODEL = next.model;
        updates.LLM_API_KEY = next.apiKey;
        updates.LLM_MODEL = next.model;
    }
    await syncEnvFile(updates);
    process.env.LLM_PROVIDER = envProvider;
    process.env.LLM_BASE_URL = updates.LLM_BASE_URL;
    process.env.LLM_API_KEY = updates.LLM_API_KEY || process.env.LLM_API_KEY || '';
    process.env.LLM_MODEL = next.model;
    if (next.provider === 'agnes') {
        process.env.AGNES_API_URL = chatUrl;
        process.env.AGNES_API_KEY = next.apiKey;
        process.env.AGNES_MODEL = next.model;
    }

    return getPublicModelConfig();
}

/** 更新 Embedding。apiKey 为空表示保持原密钥。 */
export async function updateEmbeddingConfig(patch) {
    await ensureBootstrapped();
    const current = await getActiveEmbeddingTarget();
    const next = embeddingSchema.parse({
        baseUrl: patch?.baseUrl ?? current.baseUrl,
        apiKey: patch?.apiKey === undefined || patch?.apiKey === null || String(patch.apiKey).trim() === ''
            ? current.apiKey
            : String(patch.apiKey).trim(),
        model: patch?.model ?? current.model
    });
    next.baseUrl = toEmbeddingsBaseUrl(next.baseUrl);
    if (!next.baseUrl)
        throw new Error('请填写 Embedding Base URL');
    if (!next.model)
        throw new Error('请填写 Embedding Model');
    if (!isUsableKey(next.apiKey))
        throw new Error('请填写有效的 Embedding API Key');

    const llm = memoryOverride?.llm || envLlmFallback();
    memoryOverride = { llm, embedding: next };
    await writeLocalFile(memoryOverride);

    const updates = {
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_BASE_URL: next.baseUrl,
        EMBEDDING_API_KEY: next.apiKey,
        EMBEDDING_MODEL: next.model
    };
    await syncEnvFile(updates);
    process.env.EMBEDDING_PROVIDER = 'openai-compatible';
    process.env.EMBEDDING_BASE_URL = next.baseUrl;
    process.env.EMBEDDING_API_KEY = next.apiKey;
    process.env.EMBEDDING_MODEL = next.model;

    const ragSync = await notifyRagEmbedding(next);
    const publicConfig = await getPublicModelConfig();
    return { ...publicConfig, ragSync };
}

export async function testLlmConnection(override = null) {
    let target = await getActiveLlmTarget();
    if (override) {
        const apiKey = String(override.apiKey || '').trim() || target.apiKey;
        const baseUrl = String(override.baseUrl || '').trim() || target.baseUrl;
        const model = String(override.model || '').trim() || target.model;
        const provider = String(override.provider || target.provider);
        target = {
            provider,
            baseUrl,
            chatUrl: provider === 'openclaw' ? target.chatUrl : toChatCompletionsUrl(baseUrl),
            apiKey,
            model,
            requiresLocalGateway: provider === 'openclaw',
            configured: isUsableKey(apiKey)
        };
    }
    if (!target.chatUrl || !isUsableKey(target.apiKey))
        return { ok: false, error: 'LLM 未配置完整（URL / API Key）' };
    try {
        const response = await fetch(target.chatUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${target.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: target.model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 8
            }),
            signal: AbortSignal.timeout(env.OPENCLAW_TIMEOUT_MS)
        });
        const body = await response.text();
        if (!response.ok)
            return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
        return { ok: true, provider: target.provider, model: target.model };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function testEmbeddingConnection(override = null) {
    let target = await getActiveEmbeddingTarget();
    if (override) {
        target = {
            baseUrl: toEmbeddingsBaseUrl(override.baseUrl || target.baseUrl),
            apiKey: String(override.apiKey || '').trim() || target.apiKey,
            model: String(override.model || '').trim() || target.model,
            configured: true
        };
    }
    if (!target.baseUrl || !isUsableKey(target.apiKey) || !target.model)
        return { ok: false, error: 'Embedding 未配置完整' };
    try {
        const response = await fetch(`${target.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${target.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: target.model,
                input: 'ping',
                dimensions: env.EMBEDDING_DIM,
                encoding_format: 'float'
            }),
            signal: AbortSignal.timeout(15000)
        });
        const body = await response.text();
        if (!response.ok)
            return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
        return { ok: true, model: target.model };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
