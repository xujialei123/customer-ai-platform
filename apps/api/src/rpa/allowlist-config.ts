// @ts-nocheck
/**
 * @file apps/api/src/rpa/allowlist-config.ts
 * @module RPA 与 Chrome 插件
 * @description 运行时可编辑的 RPA 客户白名单；空列表表示允许全部客户。
 * @see 联动关注：customer-allowlist.ts、guide 配置页、extension-gateway。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../config/env.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = process.env.CUSTOMER_AI_ROOT
    ? resolve(process.env.CUSTOMER_AI_ROOT)
    : resolve(currentDir, '../../../../');
const localConfigPath = resolve(runtimeRoot, 'config/rpa-allowlist.local.json');
const envFilePath = resolve(runtimeRoot, '.env');

const allowlistSchema = z.object({
    meituan: z.array(z.string()).optional(),
    douyin: z.array(z.string()).optional()
});

/** @type {{ meituan?: string[] | null, douyin?: string[] | null } | null} */
let memoryOverride = null;

function parseCsv(raw) {
    return String(raw || '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function uniqueCustomers(list) {
    const seen = new Set();
    const result = [];
    for (const item of list) {
        const value = String(item || '').trim();
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

async function readLocalFile() {
    try {
        const text = await readFile(localConfigPath, 'utf-8');
        if (!text.trim())
            return {};
        return allowlistSchema.parse(JSON.parse(text));
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

/**
 * 同步写回 .env，保证下次启动与配置页一致；只改白名单两行，不动其他配置。
 */
async function syncEnvFile(meituan, douyin) {
    let text = '';
    try {
        text = await readFile(envFilePath, 'utf-8');
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const lines = text ? text.split(/\r?\n/) : [];
    const updates = {
        MEITUAN_RPA_ALLOWED_CUSTOMERS: meituan.join(','),
        DOUYIN_RPA_ALLOWED_CUSTOMERS: douyin.join(',')
    };
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

function envFallback(platform) {
    return platform === 'douyin'
        ? parseCsv(env.DOUYIN_RPA_ALLOWED_CUSTOMERS)
        : parseCsv(env.MEITUAN_RPA_ALLOWED_CUSTOMERS);
}

/**
 * 读取生效中的白名单。
 * 优先级：内存覆盖 > local JSON > .env
 * 空数组表示「允许全部客户」。
 */
export async function getRpaAllowlistConfig() {
    const local = memoryOverride ?? await readLocalFile();
    const meituan = Array.isArray(local.meituan) ? uniqueCustomers(local.meituan) : envFallback('meituan');
    const douyin = Array.isArray(local.douyin) ? uniqueCustomers(local.douyin) : envFallback('douyin');
    return {
        meituan,
        douyin,
        meituanAllowlistEnabled: meituan.length > 0,
        douyinAllowlistEnabled: douyin.length > 0,
        source: memoryOverride ? 'memory' : (Object.keys(local).length ? 'local' : 'env')
    };
}

export async function getAllowedCustomers(platform) {
    const config = await getRpaAllowlistConfig();
    return platform === 'douyin' ? config.douyin : config.meituan;
}

/**
 * 保存白名单。传入空数组即开放全部客户；立即生效，无需重启 API。
 */
export async function updateRpaAllowlistConfig(patch) {
    const parsed = allowlistSchema.parse(patch ?? {});
    const current = await getRpaAllowlistConfig();
    const next = {
        meituan: Array.isArray(parsed.meituan) ? uniqueCustomers(parsed.meituan) : current.meituan,
        douyin: Array.isArray(parsed.douyin) ? uniqueCustomers(parsed.douyin) : current.douyin
    };
    memoryOverride = next;
    await writeLocalFile(next);
    await syncEnvFile(next.meituan, next.douyin);
    // 同步当前进程 env，便于仍直接读 env 的旧路径。
    process.env.MEITUAN_RPA_ALLOWED_CUSTOMERS = next.meituan.join(',');
    process.env.DOUYIN_RPA_ALLOWED_CUSTOMERS = next.douyin.join(',');
    return {
        ...next,
        meituanAllowlistEnabled: next.meituan.length > 0,
        douyinAllowlistEnabled: next.douyin.length > 0,
        source: 'local'
    };
}
