/**
 * @file apps/api/src/utils/terminal-log.ts
 * @module API 入口与基础设施
 * @description 终端彩色业务日志 + 内存环形缓冲，供 /logs 排查页拉取。
 * @see 联动关注：ReplyWorker、extension-gateway、Chrome 插件回执、/logs。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

export type TerminalLogEvent =
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

/** 排查页用的结构化日志条（无 ANSI）。 */
export interface TerminalLogEntry {
    id: number;
    at: string;
    ts: number;
    event: TerminalLogEvent;
    title: string;
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
    summary: string;
}

const RING_MAX = 800;
const ringBuffer: TerminalLogEntry[] = [];
let ringSeq = 0;

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

function resolvePortableLogPath() {
    const root = process.env.CUSTOMER_AI_ROOT;
    if (!root)
        return '';
    return resolve(root, 'data/logs/api.out.log');
}

function appendPortableLogLine(line: string) {
    const logPath = resolvePortableLogPath();
    if (!logPath)
        return;
    try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, `${stripAnsi(line)}\n`, 'utf-8');
    }
    catch {
        // 日志写入失败不能影响主流程。
    }
}

function pushRing(event: TerminalLogEvent, details: TerminalLogDetails, at: string, ts: number) {
    const title = titleMap[event] ?? event;
    const bits = [`[RPA] ${title}`];
    if (details.customer)
        bits.push(`客户=${oneLine(details.customer, 40)}`);
    if (details.platform)
        bits.push(`平台=${details.platform}`);
    if (details.denyReason)
        bits.push(`原因=${details.denyReason}`);
    if (details.riskLevel)
        bits.push(`风险=${details.riskLevel}`);
    ringSeq += 1;
    ringBuffer.push({
        id: ringSeq,
        at,
        ts,
        event,
        title,
        customer: details.customer ? oneLine(details.customer, 80) : undefined,
        platform: details.platform,
        riskLevel: details.riskLevel,
        allowAutoSend: details.allowAutoSend,
        denyReason: details.denyReason,
        ragHits: details.ragHits,
        clicked: details.clicked,
        method: details.method,
        duplicated: details.duplicated,
        userMessage: details.userMessage ? oneLine(details.userMessage, 240) : undefined,
        content: details.content ? oneLine(details.content, 240) : undefined,
        ragPreview: Array.isArray(details.ragPreview)
            ? details.ragPreview.slice(0, 3).map((item) => oneLine(item, 160))
            : undefined,
        summary: bits.join(' ')
    });
    while (ringBuffer.length > RING_MAX)
        ringBuffer.shift();
}

/**
 * 打印带颜色的业务事件。走 stdout，会被 run-all 的 [api] 前缀接住。
 * 同时写入内存环形缓冲，供 http://127.0.0.1:3001/logs 排查。
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
    const title = titleMap[event] ?? event;
    const now = Date.now();
    const beijing = formatBeijingTime(new Date(now));
    pushRing(event, details, beijing, now);

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

function matchEntry(entry: TerminalLogEntry, filters: {
    event?: string;
    platform?: string;
    customer?: string;
    q?: string;
}) {
    if (filters.event && filters.event !== 'all' && entry.event !== filters.event)
        return false;
    if (filters.platform && filters.platform !== 'all' && String(entry.platform || '') !== filters.platform)
        return false;
    if (filters.customer) {
        const want = filters.customer.trim();
        if (want && !String(entry.customer || '').includes(want))
            return false;
    }
    if (filters.q) {
        const needle = filters.q.trim().toLowerCase();
        if (!needle)
            return true;
        const hay = [
            entry.summary,
            entry.customer,
            entry.userMessage,
            entry.content,
            entry.denyReason,
            entry.method,
            ...(entry.ragPreview || [])
        ].join('\n').toLowerCase();
        if (!hay.includes(needle))
            return false;
    }
    return true;
}

/**
 * 读取内存环形缓冲中的最近日志（进程重启后清空，需结合文件兜底）。
 */
export function getRecentTerminalLogs(options: {
    limit?: number;
    afterId?: number;
    event?: string;
    platform?: string;
    customer?: string;
    q?: string;
} = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const afterId = Number(options.afterId) || 0;
    const filtered = ringBuffer.filter((entry) => {
        if (afterId > 0 && entry.id <= afterId)
            return false;
        return matchEntry(entry, options);
    });
    const items = afterId > 0 ? filtered.slice(0, limit) : filtered.slice(-limit);
    return {
        ok: true,
        source: 'memory',
        totalInMemory: ringBuffer.length,
        latestId: ringBuffer.length ? ringBuffer[ringBuffer.length - 1].id : 0,
        items
    };
}

/**
 * 便携包文件日志兜底：API 重启后内存空时，从 data/logs/api.out.log 尾部解析。
 * 只做简单行解析，精度低于内存结构化条目。
 */
export function getRecentTerminalLogsFromFile(options: {
    limit?: number;
    event?: string;
    platform?: string;
    customer?: string;
    q?: string;
} = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const logPath = resolvePortableLogPath();
    if (!logPath || !existsSync(logPath)) {
        return { ok: true, source: 'file', path: logPath || '', items: [], note: '无文件日志（开发态可能只打终端）' };
    }
    let text = '';
    try {
        text = readFileSync(logPath, 'utf-8');
    }
    catch {
        return { ok: false, source: 'file', path: logPath, items: [], error: '读取日志文件失败' };
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.max(limit * 4, 200));
    const parsed: TerminalLogEntry[] = [];
    let seq = 0;
    let current: TerminalLogEntry | null = null;
    const titleToEvent: Record<string, TerminalLogEvent> = Object.fromEntries(
        (Object.entries(titleMap) as [TerminalLogEvent, string][]).map(([k, v]) => [v, k])
    );

    for (const raw of tail) {
        const line = stripAnsi(raw);
        const head = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[RPA\]\s+(\S+)(.*)$/);
        if (head) {
            if (current)
                parsed.push(current);
            seq += 1;
            const at = head[1];
            const title = head[2];
            const rest = head[3] || '';
            const event: TerminalLogEvent = titleToEvent[title] || 'warn';
            const customer = rest.match(/客户=([^\s]+)/)?.[1];
            const platform = rest.match(/平台=([^\s]+)/)?.[1];
            const denyReason = rest.match(/原因=([^\s]+)/)?.[1];
            const riskLevel = rest.match(/风险=([^\s]+)/)?.[1];
            current = {
                id: seq,
                at,
                ts: Date.parse(`${at.replace(' ', 'T')}+08:00`) || Date.now(),
                event,
                title,
                customer,
                platform,
                denyReason,
                riskLevel,
                summary: line.trim()
            };
            continue;
        }
        if (!current)
            continue;
        const ask = line.match(/^\s*问>\s*(.+)$/);
        if (ask) {
            current.userMessage = oneLine(ask[1], 240);
            continue;
        }
        const ans = line.match(/^\s*答>\s*(.+)$/);
        if (ans) {
            current.content = oneLine(ans[1], 240);
            continue;
        }
    }
    if (current)
        parsed.push(current);

    const items = parsed.filter((entry) => matchEntry(entry, options)).slice(-limit);
    return {
        ok: true,
        source: 'file',
        path: logPath,
        items
    };
}
