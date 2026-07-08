// @ts-nocheck
import { startMeituanWatcher } from './meituan.watcher.js';
// 真实经营宝 watcher 使用独立入口，避免 mock 测试与正式账号共用浏览器目录或选择器。
startMeituanWatcher().catch((error) => {
    console.error('经营宝 RPA 启动失败：', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
