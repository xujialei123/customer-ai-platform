// @ts-nocheck
/**
 * @file apps/api/src/rpa/meituan-real.watcher.ts
 * @module RPA 与 Chrome 插件
 * @description 美团真实页 Playwright 兼容入口。
 * @see 联动关注：真实账号灰度验证。
 */
import { startMeituanWatcher } from './meituan.watcher.js';
// 真实经营宝 watcher 使用独立入口，避免 mock 测试与正式账号共用浏览器目录或选择器。
startMeituanWatcher().catch((error) => {
    console.error('经营宝 RPA 启动失败：', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
