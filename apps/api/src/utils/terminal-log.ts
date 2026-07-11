/**
 * @file apps/api/src/utils/terminal-log.ts
 * @module API 入口与基础设施
 * @description 终端彩色业务日志，方便在 pnpm dev 输出里一眼看到草稿和发送结果。
 * @see 联动关注：ReplyWorker、extension-gateway、Chrome 插件回执。
 */

// Windows Terminal / 新版 PowerShell 支持 ANSI；颜色只用于开发排查，不写入业务数据。
const ansi = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    white: '\x1b[37m'
};

function paint(color, text) {
    return `${color}${text}${ansi.reset}`;
}

function oneLine(text, max = 160) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= max)
        return normalized;
    return `${normalized.slice(0, max - 1)}…`;
}

/**
 * 打印带颜色的业务事件。走 stdout，会被 run-all 的 [api] 前缀接住。
 */
export function terminalLog(event, details = {}) {
    const palette = {
        rag: ansi.cyan,
        draft: ansi.magenta,
        push: ansi.blue,
        click_ok: ansi.green,
        click_fail: ansi.red,
        fill_only: ansi.yellow,
        warn: ansi.yellow,
        error: ansi.red
    };
    const color = palette[event] ?? ansi.white;
    const titleMap = {
        rag: '知识库检索',
        draft: 'AI 草稿',
        push: '推送插件',
        click_ok: '已点发送',
        click_fail: '发送失败',
        fill_only: '仅回填',
        warn: '警告',
        error: '错误'
    };
    const title = titleMap[event] ?? event;
    const parts = [
        paint(ansi.bold + color, `[RPA] ${title}`)
    ];
    if (details.customer)
        parts.push(paint(ansi.dim, `客户=${oneLine(details.customer, 40)}`));
    if (details.platform)
        parts.push(paint(ansi.dim, `平台=${details.platform}`));
    if (details.riskLevel)
        parts.push(paint(details.riskLevel === 'low' ? ansi.green : ansi.yellow, `风险=${details.riskLevel}`));
    if (details.allowAutoSend != null)
        parts.push(paint(details.allowAutoSend ? ansi.green : ansi.yellow, `自动发送=${details.allowAutoSend ? '是' : '否'}`));
    if (details.denyReason)
        parts.push(paint(ansi.yellow, `原因=${details.denyReason}`));
    if (details.ragHits != null)
        parts.push(paint(ansi.cyan, `检索=${details.ragHits}条`));
    // 仅回填时不要误报“按钮点击=失败”，避免和真正的点击失败混淆。
    if (details.clicked != null && (event === 'click_ok' || event === 'click_fail'))
        parts.push(paint(details.clicked ? ansi.green : ansi.red, `按钮点击=${details.clicked ? '成功' : '失败'}`));
    if (details.method)
        parts.push(paint(ansi.dim, `方式=${details.method}`));
    console.log(parts.join(' '));
    if (details.userMessage)
        console.log(paint(ansi.dim, `  问> ${oneLine(details.userMessage)}`));
    if (details.content)
        console.log(paint(color, `  答> ${oneLine(details.content)}`));
    if (Array.isArray(details.ragPreview) && details.ragPreview.length > 0) {
        for (const [index, item] of details.ragPreview.entries())
            console.log(paint(ansi.cyan, `  证${index + 1}> ${oneLine(item, 120)}`));
    }
}
