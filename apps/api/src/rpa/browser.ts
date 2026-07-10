// @ts-nocheck
/**
 * @file apps/api/src/rpa/browser.ts
 * @module RPA 与 Chrome 插件
 * @description Playwright persistent context 浏览器启动器（兼容模式）。
 * @see 联动关注：非默认插件模式时使用。
 */
import { chromium } from 'playwright';
// 使用 persistent context 保存登录态。
// 这样你手动扫码/登录一次后，后续可以复用浏览器用户数据目录。
export async function createPersistentBrowserContext(userDataDir) {
    return chromium.launchPersistentContext(userDataDir, {
        // Windows 上 Playwright 自带浏览器可能尚未下载，优先复用本机 Chrome。
        // 真实 RPA 也更适合使用持久化的本机浏览器环境保存登录态。
        channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
        headless: false,
        viewport: { width: 1440, height: 900 }
    });
}
