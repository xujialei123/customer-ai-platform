// @ts-nocheck
/**
 * @file apps/api/src/rpa/selector-config.ts
 * @module RPA 与 Chrome 插件
 * @description 读写平台 RPA DOM 选择器配置。
 * @see 联动关注：RPA 配置路由和插件默认值。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const localConfigPath = fileURLToPath(new URL('../../../../config/rpa-selectors.local.json', import.meta.url));
const exampleConfigPath = fileURLToPath(new URL('../../../../config/rpa-selectors.example.json', import.meta.url));
// 后台管理页保存 RPA 选择器时复用这份 schema。
// 选择器允许局部更新，因为真实平台改版通常只影响其中一两个字段。
export const rpaSelectorSchema = z.object({
    url: z.string().min(1).optional(),
    defaultShopId: z.string().min(1).optional(),
    defaultConversationId: z.string().min(1).optional(),
    defaultCustomerId: z.string().min(1).optional(),
    selectors: z.object({
        messageItem: z.string().min(1),
        messageText: z.string().min(1),
        messageIdAttribute: z.string().min(1).optional(),
        customerNameAttribute: z.string().min(1).optional(),
        createdAtAttribute: z.string().min(1).optional()
    }).partial().optional(),
    pageDataset: z.object({
        platform: z.string().min(1).optional(),
        shopId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
        customerId: z.string().min(1).optional()
    }).partial().optional()
}).partial();
// 读取 JSON 配置时显式指定 UTF-8。
// Windows 默认编码不可控，配置里将来可能包含中文备注或中文选择器说明。
async function readJsonFile(path) {
    try {
        // Windows 下显式使用 UTF-8，避免中文选择器说明或备注乱码。
        const text = await readFile(path, 'utf-8');
        if (!text.trim())
            return {};
        return JSON.parse(text);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return {};
        throw error;
    }
}
// 写本机配置文件时保持 UTF-8 无 BOM。
// local 文件不进 git，用来保存不同机器、不同账号下的真实页面选择器。
async function writeJsonFile(path, value) {
    await mkdir(dirname(path), { recursive: true });
    // 本机配置必须写成 UTF-8 无 BOM，方便后续后台页面保存中文平台备注。
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
// 把默认配置和本机覆盖配置合并。
// 这样 example 文件可以提供安全兜底，本机只维护真实平台变化的部分。
function mergeConfig(base, override) {
    return {
        ...base,
        url: override.url ?? base.url,
        defaultShopId: override.defaultShopId ?? base.defaultShopId,
        defaultConversationId: override.defaultConversationId ?? base.defaultConversationId,
        defaultCustomerId: override.defaultCustomerId ?? base.defaultCustomerId,
        selectors: {
            ...base.selectors,
            ...override.selectors
        },
        pageDataset: {
            ...base.pageDataset,
            ...override.pageDataset
        }
    };
}
// 加载 example + local 两层配置。
// local 优先级更高，方便用户在不改代码的情况下适配自己的抖音/美团后台页面。
export async function loadRpaSelectorOverrides() {
    const example = await readJsonFile(exampleConfigPath);
    const local = await readJsonFile(localConfigPath);
    return { ...example, ...local };
}
// watcher 启动时调用这里获得最终配置。
// 选择器变更后建议重启 watcher，避免运行中的页面同时使用新旧规则造成重复抓取。
export async function loadRpaWatcherConfig(base) {
    const all = await loadRpaSelectorOverrides();
    return mergeConfig(base, all[base.platform] ?? {});
}
// 给后台管理页读取当前平台配置。
// 返回值包含 example 默认值和 local 覆盖值，便于页面直接展示最终生效配置。
export async function getRpaSelectorConfig(platform) {
    const all = await loadRpaSelectorOverrides();
    return all[platform] ?? {};
}
// 给后台管理页保存当前平台配置。
// 只做局部合并，不覆盖用户之前已经调好的其他选择器。
export async function updateRpaSelectorConfig(platform, patch) {
    const parsed = rpaSelectorSchema.parse(patch);
    const local = await readJsonFile(localConfigPath);
    const current = local[platform] ?? {};
    // 按平台局部合并，页面改版时只需要更新变化的选择器，不会冲掉其他配置。
    local[platform] = {
        ...current,
        ...parsed,
        selectors: {
            ...current.selectors,
            ...parsed.selectors
        },
        pageDataset: {
            ...current.pageDataset,
            ...parsed.pageDataset
        }
    };
    await writeJsonFile(localConfigPath, local);
    return local[platform];
}
