// @ts-nocheck
/**
 * @file apps/api/src/dev/run-all.ts
 * @module API 入口与基础设施
 * @description 开发编排：Docker、OpenClaw、API、RAG、Mock 站点和专用 Chrome。
 * @see 联动关注：端口、进程清理、README 启动说明。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
const currentDir = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(currentDir, '../../../..');
loadDotEnv({ path: resolve(projectRoot, '.env'), encoding: 'utf8' });
const dockerDesktopPath = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const dockerBinPath = 'C:\\Program Files\\Docker\\Docker\\resources\\bin';
const chromeCandidates = [
    process.env.CHROME_PATH ?? '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const openClawPortableRoot = process.env.OPENCLAW_PORTABLE_ROOT ?? '';
const openClawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789';
const processes = [
    {
        name: 'rag',
        command: 'pnpm',
        args: ['--filter', '@customer-ai/rag-service', 'dev'],
        cwd: projectRoot
    },
    {
        name: 'api',
        command: 'tsx',
        args: ['watch', 'src/main.ts']
    },
    {
        name: 'rpa-site',
        command: 'tsx',
        args: ['watch', 'src/rpa/mock-chat-server.ts']
    },
];
if (String(process.env.RPA_MOCK_MODE ?? 'extension').toLowerCase() === 'playwright') {
    // 旧 Playwright Watcher 仅作为兼容模式保留；默认插件模式不能同时消费同一批 Mock 消息。
    processes.push({
        name: 'douyin-rpa',
        command: 'tsx',
        args: ['watch', 'src/rpa/mock-site.watcher.ts'],
        env: { RPA_PLATFORM: 'douyin' }
    });
}
if (String(process.env.MEITUAN_RPA_MODE ?? 'extension').toLowerCase() === 'playwright'
    && String(process.env.MEITUAN_RPA_ENABLED ?? '').toLowerCase() === 'true') {
    // 真实经营宝使用独立 persistent profile；默认只读，自动发送由单独安全开关控制。
    processes.push({
        name: 'meituan-real-rpa',
        command: 'tsx',
        args: ['watch', 'src/rpa/meituan-real.watcher.ts']
    });
}
const children = [];
process.stdout.on('error', (error) => {
    if (error.code !== 'EPIPE')
        throw error;
});
process.stderr.on('error', (error) => {
    if (error.code !== 'EPIPE')
        throw error;
});
function writeLine(line) {
    try {
        process.stdout.write(`${line}\n`);
    }
    catch (error) {
        if (error?.code !== 'EPIPE')
            throw error;
    }
}
function prefixLines(name, chunk) {
    const text = chunk.toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
            writeLine(`[${name}] ${line}`);
        }
    }
}
function runCommand(command, args, cwd = projectRoot, silent = false) {
    return new Promise((resolvePromise) => {
        const child = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                PATH: `${dockerBinPath};${process.env.PATH ?? ''}`
            },
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        if (!silent) {
            child.stdout?.on('data', (chunk) => prefixLines(command, chunk));
            child.stderr?.on('data', (chunk) => prefixLines(command, chunk));
        }
        child.on('exit', (code) => resolvePromise(code ?? 0));
        child.on('error', () => resolvePromise(1));
    });
}
async function isDockerReady() {
    const code = await runCommand('docker', ['info'], projectRoot, true);
    return code === 0;
}
async function waitForDocker() {
    for (let index = 0; index < 90; index += 1) {
        const code = await runCommand('docker', ['info'], projectRoot, true);
        if (code === 0)
            return true;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
    return false;
}
async function ensurePortFree(port) {
    const code = await runCommand('powershell', [
        '-NoProfile',
        '-Command',
        `"if (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object State -eq Listen) { exit 1 } else { exit 0 }"`
    ], projectRoot, true);
    if (code !== 0) {
        writeLine(`[dev] 端口 ${port} 已被占用。请先关闭旧的 pnpm dev / node 进程，或执行：`);
        writeLine(`[dev] $p = (Get-NetTCPConnection -LocalPort ${port} | Where-Object State -eq Listen | Select-Object -First 1 -ExpandProperty OwningProcess); Stop-Process -Id $p -Force`);
        return false;
    }
    return true;
}
async function ensureDockerServices() {
    // API 依赖 PostgreSQL 和 Redis；先拉起 Docker Compose 可以避免 Fastify/BullMQ 一启动就刷连接错误。
    // 如果用户没有安装或启动 Docker Desktop，这里给出明确提示，而不是让后续错误淹没真正原因。
    let dockerReady = await isDockerReady();
    if (!dockerReady && existsSync(dockerDesktopPath)) {
        writeLine('[dev] Docker 未就绪，正在尝试启动 Docker Desktop...');
        spawn(dockerDesktopPath, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        }).unref();
        dockerReady = await waitForDocker();
    }
    if (!dockerReady) {
        writeLine('[dev] Docker Desktop 未就绪，无法启动 PostgreSQL / Redis。请先打开 Docker Desktop 后重新运行 pnpm dev。');
        return false;
    }
    const composeCode = await runCommand('docker', ['compose', 'up', '-d']);
    if (composeCode !== 0) {
        writeLine('[dev] docker compose up -d 失败，请检查 Docker Desktop 和 docker-compose.yml。');
        return false;
    }
    return true;
}
async function isOpenClawReady() {
    try {
        const response = await fetch(openClawGatewayUrl, { signal: AbortSignal.timeout(1500) });
        return response.status >= 200 && response.status < 500;
    }
    catch {
        return false;
    }
}
async function ensureOpenClaw() {
    if (await isOpenClawReady()) {
        writeLine(`[dev] OpenClaw 已就绪：${openClawGatewayUrl}`);
        return true;
    }
    const autoStart = String(process.env.OPENCLAW_AUTO_START ?? '').toLowerCase() === 'true';
    const startScript = resolve(openClawPortableRoot, 'Start-OpenClaw.ps1');
    if (!autoStart || !openClawPortableRoot || !existsSync(startScript)) {
        writeLine('[dev] OpenClaw 未运行，且便携版自动启动未配置。');
        return false;
    }
  // Windows 原生包装进程负责脱离当前 Node 进程，避免终端关闭时把前台网关一并结束。
  const wrapperScript = resolve(projectRoot, 'scripts/start-openclaw-detached.ps1');
  const launchCode = await runCommand('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', wrapperScript,
    '-OpenClawRoot', openClawPortableRoot
  ], projectRoot, true);
  if (launchCode !== 0) {
    writeLine('[dev] 便携 OpenClaw 启动命令执行失败。');
    return false;
  }
    writeLine('[dev] 正在启动便携 OpenClaw...');
    for (let attempt = 0; attempt < 90; attempt += 1) {
        if (await isOpenClawReady()) {
            writeLine(`[dev] OpenClaw 启动成功：${openClawGatewayUrl}`);
            return true;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
    writeLine('[dev] OpenClaw 启动超时，请检查便携包 data/logs。');
    return false;
}
function startProcess(item) {
    // 统一由一个 dev 命令拉起 API 和 RPA 测试环境，避免手工开多个终端时漏启动某一环。
    const child = spawn(item.command, item.args, {
        cwd: item.cwd ?? process.cwd(),
        env: {
            ...process.env,
            ...item.env
        },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk) => prefixLines(item.name, chunk));
    child.stderr?.on('data', (chunk) => prefixLines(item.name, chunk));
    child.on('exit', (code, signal) => {
        writeLine(`[${item.name}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
    children.push(child);
}
async function openKnowledgeAdminWhenReady() {
    const url = 'http://127.0.0.1:8787/kb-admin';
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                // 只在 RAG 服务真正就绪后打开一次，避免浏览器先显示连接失败页面。
                spawn('powershell', ['-NoProfile', '-Command', `Start-Process '${url}'`], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                }).unref();
                writeLine(`[dev] 已自动打开知识库上传页面：${url}`);
                return;
            }
        }
        catch {
            // 服务仍在启动，短暂等待后继续检查。
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    writeLine(`[dev] 知识库页面未能自动打开，请手工访问：${url}`);
}
async function openExtensionChromeWhenReady() {
    if (String(process.env.RPA_EXTENSION_BROWSER_AUTO_OPEN ?? 'true').toLowerCase() !== 'true')
        return;
    const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
    if (!chromePath) {
        writeLine('[dev] 未找到系统 Chrome，请设置 CHROME_PATH 后手工打开 RPA Mock 页面。');
        return;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch('http://127.0.0.1:3100/?platform=meituan', { signal: AbortSignal.timeout(1000) });
            if (response.ok) {
                const profileDir = resolve(projectRoot, '.sessions/extension-chrome');
                const extensionDir = resolve(projectRoot, 'extensions/customer-ai-rpa');
                const preferencesPath = resolve(profileDir, 'Default/Preferences');
                let extensionInstalled = false;
                try {
                    // 正式版 Chrome 已可能忽略 --load-extension，因此读取持久 Profile 判断是否需要引导首次手工安装。
                    const preferences = JSON.parse(readFileSync(preferencesPath, 'utf-8'));
                    const extensionSettings = preferences?.extensions?.settings ?? {};
                    extensionInstalled = Object.values(extensionSettings).some((item) => {
                        const configuredPath = typeof item?.path === 'string' ? resolve(item.path) : '';
                        return configuredPath.toLowerCase() === extensionDir.toLowerCase();
                    });
                }
                catch {
                    // 新 Profile 尚无 Preferences，首次打开扩展管理页即可。
                }
                // 使用固定 user-data-dir 启动真正的系统 Chrome，不添加 Playwright 或 remote-debugging 参数。
                const urls = extensionInstalled
                    ? ['http://127.0.0.1:3100/?platform=meituan']
                    : ['chrome://extensions/', 'http://127.0.0.1:3100/?platform=meituan'];
                const browser = spawn(chromePath, [
                    `--user-data-dir=${profileDir}`,
                    '--profile-directory=Default',
                    '--new-window',
                    '--no-first-run',
                    '--no-default-browser-check',
                    ...urls
                ], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false
                });
                browser.unref();
                writeLine(`[dev] 已打开系统 Chrome 插件测试窗口，持久化目录：${profileDir}`);
                if (!extensionInstalled) {
                    writeLine('[dev] 首次使用：请在 chrome://extensions 开启开发者模式，加载已解压的扩展：');
                    writeLine(`[dev] ${extensionDir}`);
                }
                return;
            }
        }
        catch {
            // Mock 服务仍在启动，稍后再打开浏览器，避免落到 Chrome 的连接失败缓存页。
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    writeLine('[dev] RPA Mock 页面未就绪，请手工访问：http://127.0.0.1:3100/?platform=meituan');
}
function shutdown() {
    // 父进程退出时清理子进程，防止端口 3001/3100 被残留进程占用。
    for (const child of children) {
        if (!child.killed) {
            child.kill();
        }
    }
}
process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
});
process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
});
for (const item of processes) {
    // 这里不做并发启动前置依赖，因为 API/RPA watcher 都依赖 Docker 服务已经可用。
    // Docker 检查放在 main() 中统一完成，避免多个子进程同时输出无意义连接错误。
    void item;
}
async function main() {
    if (!await ensurePortFree(3001))
        process.exit(1);
    if (!await ensurePortFree(3100))
        process.exit(1);
    const dockerReady = await ensureDockerServices();
    if (!dockerReady)
        process.exit(1);
    const openClawReady = await ensureOpenClaw();
    if (!openClawReady)
        process.exit(1);
    for (const item of processes) {
        startProcess(item);
    }
    writeLine('开发环境启动中：OpenClaw + API + RAG 知识库页面 + RPA mock 页面 + Chrome 扩展网关');
    writeLine('[dev] 美团扩展状态：http://127.0.0.1:3001/rpa/extension/status');
    writeLine('[dev] 知识库上传页面：http://127.0.0.1:8787/kb-admin');
    void openKnowledgeAdminWhenReady();
    if (String(process.env.RPA_MOCK_MODE ?? 'extension').toLowerCase() === 'extension')
        void openExtensionChromeWhenReady();
}
main().catch((error) => {
    writeLine(`开发环境启动失败：${error instanceof Error ? error.message : String(error)}`);
    shutdown();
    process.exit(1);
});
