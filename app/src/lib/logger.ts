/**
 * 分级日志系统。
 *
 * 设计目标：
 *  1) 用户不该看到技术细节 —— 默认 level = warn，且 UI 层永不直接消费
 *  2) 开发/调试需要全量 —— debug 开关打开后 level = debug
 *  3) 移动端无法随时开控制台 —— 保留环形缓冲，可在调试面板回看
 *  4) 零依赖、可被后端与前端共用
 *
 * 级别：error > warn > info > debug
 * 环形缓冲：默认保留最近 500 条，防止长时间运行内存膨胀。
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

export interface LogEntry {
    ts: number;
    level: LogLevel;
    /** 来源模块，便于过滤 */
    scope: string;
    message: string;
    /** 附加上下文（对象会被序列化） */
    detail?: unknown;
}

const BUFFER_LIMIT = 500;
const STORAGE_KEY = 'tavern.debug';

/** 是否开启 debug（决定 info/debug 是否输出） */
let debugEnabled = false;

/** 环形缓冲（始终记录 warn 及以上；debug 开启时记录全部） */
const buffer: LogEntry[] = [];

/** 订阅者（调试面板用） */
const listeners = new Set<(entries: readonly LogEntry[]) => void>();

function loadDebugFlag(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

debugEnabled = loadDebugFlag();

export function isDebugEnabled(): boolean {
    return debugEnabled;
}

export function setDebugEnabled(on: boolean) {
    debugEnabled = on;
    try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
        /* 静默 */
    }
    log('info', 'log', `debug 模式${on ? '已开启' : '已关闭'}`);
}

function push(entry: LogEntry) {
    buffer.push(entry);
    if (buffer.length > BUFFER_LIMIT) {
        buffer.splice(0, buffer.length - BUFFER_LIMIT);
    }
    for (const fn of listeners) {
        try {
            fn(buffer);
        } catch {
            /* 订阅者异常不影响日志 */
        }
    }
}

/**
 * 写一条日志。
 * @param level 级别
 * @param scope 来源模块（如 'backend' / 'ctx' / 'memory'）
 * @param message 人类可读消息
 * @param detail 可选附加上下文
 */
export function log(level: LogLevel, scope: string, message: string, detail?: unknown) {
    const entry: LogEntry = { ts: Date.now(), level, scope, message, detail };

    // 缓冲策略：warn+ 常驻；info/debug 仅在 debug 模式保留
    const shouldBuffer = LEVEL_ORDER[level] <= LEVEL_ORDER.warn || debugEnabled;
    if (shouldBuffer) push(entry);

    // 控制台输出：仅 debug 模式（避免污染用户控制台）
    if (!debugEnabled) return;
    const tag = `[${scope}]`;
    switch (level) {
        case 'error':
            console.error(tag, message, detail ?? '');
            break;
        case 'warn':
            console.warn(tag, message, detail ?? '');
            break;
        case 'info':
            console.info(tag, message, detail ?? '');
            break;
        default:
            console.debug(tag, message, detail ?? '');
    }
}

export const logger = {
    error: (scope: string, msg: string, detail?: unknown) => log('error', scope, msg, detail),
    warn: (scope: string, msg: string, detail?: unknown) => log('warn', scope, msg, detail),
    info: (scope: string, msg: string, detail?: unknown) => log('info', scope, msg, detail),
    debug: (scope: string, msg: string, detail?: unknown) => log('debug', scope, msg, detail),
};

/** 读取日志快照（调试面板用）。 */
export function getLogs(): readonly LogEntry[] {
    return buffer;
}

/** 清空日志。 */
export function clearLogs() {
    buffer.length = 0;
    for (const fn of listeners) fn(buffer);
}

/** 订阅日志变化，返回取消订阅函数。 */
export function subscribeLogs(fn: (entries: readonly LogEntry[]) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** 导出为文本（用户反馈问题时附上）。 */
export function exportLogs(): string {
    return buffer
        .map((e) => {
            const time = new Date(e.ts).toISOString();
            const detail = e.detail === undefined ? '' : ` ${safeStringify(e.detail)}`;
            return `${time} [${e.level.toUpperCase()}] [${e.scope}] ${e.message}${detail}`;
        })
        .join('\n');
}

function safeStringify(v: unknown): string {
    try {
        return typeof v === 'string' ? v : JSON.stringify(v);
    } catch {
        return String(v);
    }
}
