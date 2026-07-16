/**
 * @file apps/api/src/utils/terminal-log.ts
 * @module API 入口与基础设施
 * @description 终端彩色业务日志，方便在 pnpm dev 输出里一眼看到草稿和发送结果。
 * @see 联动关注：ReplyWorker、extension-gateway、Chrome 插件回执。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

type TerminalLogEvent =
    | 'inbound'
    | 'outbound'
    | 'rag'
    | 'draft'
    | 'push'
    | 'click_ok'
    | 'click_fail'
    | 'fill_only'
    | 'warn'
    | 'error';

interface TerminalLogDetails {
    customer?: string;
    platform?: string;
    riskLevel?: string;
    allowAutoSend?: boolean;
    denyReason?: string;
    ragHits?: number;
    clicked?: boolean;
    method?: string;
    duplicated?: boolean;
    userMessage?: string;
    content?: string;
    ragPreview?: string[];
}

function paint(color: string, text: string) {
    return `${color}${text}${ansi.reset}`;
}

function oneLine(text: unknown, max = 160) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= max)
        return normalized;
    return `${normalized.slice(0, max - 1)}…`;
}

function stripAnsi(text: string) {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 北京时间（Asia/Shanghai）本地串，供终端与便携包日志对齐排查。 */
function formatBeijingTime(date = new Date()) {
    // sv-SE → YYYY-MM-DD HH:mm:ss，再锁到东八区，避免服务器本机时区干扰。
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

function appendPortableLogLine(line: string) {
    const root = process.env.CUSTOMER_AI_ROOT;
    if (!root)
        return;
    const logPath = resolve(root, 'data/logs/api.out.log');
    try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, `${stripAnsi(line)}\n`, 'utf-8');
    }
    catch {
        // 日志写入失败不能影响主流程。
    }
}

/**
 * 打印带颜色的业务事件。走 stdout，会被 run-all 的 [api] 前缀接住。
 */
export function terminalLog(event: TerminalLogEvent, details: TerminalLogDetails = {}) {
    const palette: Record<TerminalLogEvent, string> = {
        inbound: ansi.cyan,
        outbound: ansi.green,
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
    const titleMap: Record<TerminalLogEvent, string> = {
        inbound: '收到消息',
        outbound: '确认已发送',
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
    const beijing = formatBeijingTime();
    const parts = [
        paint(ansi.dim, beijing),
        paint(ansi.bold + color, `[RPA] ${title}`)
    ];
    if (details.customer)
        parts.push(paint(ansi.dim, `客户=${oneLine(details.customer, 40)}`));
    if (details.platform)
        parts.push(paint(ansi.dim, `平台=${details.platform}`));
    if (details.duplicated != null)
        parts.push(paint(details.duplicated ? ansi.yellow : ansi.green, details.duplicated ? '重复=是' : '新消息'));
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
    appendPortableLogLine(parts.join(' '));
    if (details.userMessage) {
        const line = `  问> ${oneLine(details.userMessage)}`;
        console.log(paint(ansi.dim, line));
        appendPortableLogLine(line);
    }
    if (details.content && event !== 'inbound') {
        const line = `  答> ${oneLine(details.content)}`;
        console.log(paint(color, line));
        appendPortableLogLine(line);
    }
    if (details.content && event === 'inbound') {
        const line = `  问> ${oneLine(details.content)}`;
        console.log(paint(color, line));
        appendPortableLogLine(line);
    }
    if (Array.isArray(details.ragPreview) && details.ragPreview.length > 0) {
        for (const [index, item] of details.ragPreview.entries()) {
            const line = `  证${index + 1}> ${oneLine(item, 120)}`;
            console.log(paint(ansi.cyan, line));
            appendPortableLogLine(line);
        }
    }
}
