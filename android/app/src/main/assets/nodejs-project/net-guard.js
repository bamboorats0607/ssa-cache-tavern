/**
 * Android 壳的网络安全策略：**出站目标白名单** + **来源（Origin）白名单**。
 *
 * ── 为什么需要这个文件 ─────────────────────────────────────────────────────
 * 这个内嵌后端监听在 `127.0.0.1:4444`，任何**同机**的浏览器页面或 App 都能访问它。
 * 它同时具备两个危险性质：
 *   1) 上游 `/api/backends/chat-completions/generate` 会把请求体里的 `custom_url`
 *      原样当作出站目标 —— 即一个**无鉴权的 SSRF 原语**（可探测/访问环回、局域网、
 *      链路本地 169.254.169.254 等内网资源）；
 *   2) 上游默认 CORS 配置里含 `null` 起源 —— 沙箱 iframe / file:// / data: 页面
 *      拿到的 `Origin: null` 会被放行，于是**恶意网页也能读走响应**。
 * 二者叠加 = 「用户点开一个恶意网页 → 该网页以内网视角扫描并读回结果」。
 *
 * ── 纪律（用户钩子，硬约束）────────────────────────────────────────────────
 * `服务端请求 URL 时：仅允许 http/https；发请求前校验 host，并拒绝 localhost、环回、
 *  私有和保留地址。`
 * 因此本模块的策略是 **fail-closed**：只允许解析到**公网单播**地址的 http/https 目标；
 * 其余（环回 / 私有 / 链路本地 / 运营商级 NAT / 保留 / 组播 / 未指定 / IPv4-mapped 到上述
 * 任一者 / 6to4 / Teredo / NAT64 / 域名解析不出来）一律拒绝。
 *
 * 代价（有意接受，并已登记）：**本机或局域网里自建的模型服务（如 LM Studio、
 * Ollama、llama.cpp）从此不可作为模型端点**。这是上述硬约束的直接推论，不是缺陷。
 *
 * ── 为什么不用上游自带的 private-request-filter ────────────────────────────
 * 上游有 `src/private-request-filter.js`，但它（a）默认关闭；（b）其地址表**漏**了
 * `0.0.0.0/8`、`::/128`、IPv4-mapped（`::ffff:127.0.0.1`）、`100.64/10`、`224/4`、
 * `240/4` 等可用于绕过的形态；（c）只替换 globalAgent，不改上游源码即无法收紧。
 * 本模块用 `ipaddr.js` 的 range() 分类（只放行 `unicast`），比手写 CIDR 更不易漏。
 *
 * ── 它防护什么、不防护什么 ─────────────────────────────────────────────────
 * 防护：Node 侧 node-fetch / http.request 走的出站请求（含上游的模型代理），
 *       以及浏览器发起的跨源请求（Origin 白名单 + CORS 头收敛）。
 * 不防护（如实登记）：同机**原生 App**（不受 CORS 约束、可自带 Origin 头）直接调用本机
 *       后端 —— 那需要前后端共享密钥，上游没有该机制；此类攻击者的权限已高于本进程。
 */

import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { Agent } from 'agent-base';

// ---------------------------------------------------------------------------
// 一、出站目标策略
// ---------------------------------------------------------------------------

/** 允许的协议：只允许这两种（`file:` / `ftp:` / `gopher:` 等一律拒绝）。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 明确禁止的**主机名**（不是 IP 字面量时的兜底）。
 * 这些名字在不同平台上可能被解析成环回或内网，且解析行为可被 hosts/搜索域影响。
 */
const BLOCKED_NAME_RE = /(^|\.)(localhost|local|internal|home\.arpa|lan|intranet)$/i;

/**
 * 判断一个 IP 字面量是否可放行。
 *
 * 只放行 `unicast`（真·公网单播）。IPv4-mapped（`::ffff:a.b.c.d`）先拆回 IPv4 再判——
 * 否则 `::ffff:127.0.0.1` 会被 ipaddr.js 归为 `ipv4Mapped` 而绕过环回检查。
 *
 * @param {string} ip IP 字面量（v4 或 v6）
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function classifyAddress(ip) {
    let addr;
    try {
        addr = ipaddr.parse(String(ip));
    } catch {
        return { allowed: false, reason: `无法解析的 IP 字面量：${ip}` };
    }

    if (addr.kind() === 'ipv6' && typeof addr.isIPv4MappedAddress === 'function' && addr.isIPv4MappedAddress()) {
        const v4 = addr.toIPv4Address();
        const inner = classifyAddress(v4.toString());
        return inner.allowed
            ? inner
            : { allowed: false, reason: `IPv4-mapped 到非公网地址（${ip} → ${v4.toString()}）：${inner.reason}` };
    }

    const range = addr.range();
    if (range === 'unicast') return { allowed: true, reason: null };
    return { allowed: false, reason: `地址属于 ${range} 段（${ip}），非公网单播` };
}

/**
 * 校验目标 URL 的**协议与字面形态**（不解析 DNS）。
 *
 * @param {string} raw 用户/调用方给出的 URL
 * @returns {{ ok: boolean, url?: URL, host?: string, reason?: string }}
 */
export function checkTargetShape(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return { ok: false, reason: '目标地址为空' };
    }
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        return { ok: false, reason: `目标地址不是合法 URL：${raw}` };
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return { ok: false, reason: `只允许 http/https，收到 ${url.protocol}//` };
    }
    if (url.username || url.password) {
        // `http://user:pass@host/` 形态常用于混淆真实目标，直接拒绝
        return { ok: false, reason: '目标地址不得内嵌用户名/密码' };
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) return { ok: false, reason: '目标地址没有主机名' };
    if (BLOCKED_NAME_RE.test(host)) {
        return { ok: false, reason: `目标是本机/内网保留名（${host}）` };
    }
    return { ok: true, url, host };
}

/**
 * 解析主机名并校验**每一个**返回地址（任一不合格即拒绝），返回**钉住的 IP**。
 *
 * 「钉住」是防 DNS rebinding 的关键：校验用的是解析结果，之后连接**只用这个 IP**，
 * 不再二次解析，因此「校验时是公网、连接时变环回」的时间窗被消除。
 *
 * 解析不出来 → 拒绝（fail-closed；与上游 `allowUnresolvedHosts: false` 同口径）。
 *
 * @param {string} host
 * @param {{ lookup?: typeof dns.promises.lookup }} [deps] 便于门禁注入假解析器
 * @returns {Promise<{ ok: boolean, ip?: string, addresses?: string[], reason?: string }>}
 */
export async function resolveAndValidate(host, deps = {}) {
    const lookup = deps.lookup ?? dns.promises.lookup;

    // agent-base 传下来的可能是带方括号的 IPv6 字面量（`[2606:4700::1111]`），
    // net.isIP 不认这种形态 → 必须先剥括号，否则公网 IPv6 目标会被误判为「无法解析」。
    const bare = String(host).replace(/^\[|\]$/g, '');

    const literal = net.isIP(bare);
    if (literal) {
        const verdict = classifyAddress(bare);
        return verdict.allowed ? { ok: true, ip: bare, addresses: [bare] } : { ok: false, reason: verdict.reason };
    }

    let records;
    try {
        records = await lookup(bare, { all: true });
    } catch (e) {
        return { ok: false, reason: `主机无法解析（${bare}）：${e?.code ?? e?.message ?? e}` };
    }
    const addresses = (Array.isArray(records) ? records : [records])
        .map((r) => (typeof r === 'string' ? r : r?.address))
        .filter((a) => typeof a === 'string' && a !== '');
    if (addresses.length === 0) {
        return { ok: false, reason: `主机没有可用地址（${bare}）` };
    }

    for (const address of addresses) {
        const verdict = classifyAddress(address);
        if (!verdict.allowed) {
            return { ok: false, reason: `主机 ${bare} 解析到非公网地址：${verdict.reason}` };
        }
    }
    return { ok: true, ip: addresses[0], addresses };
}

/**
 * 完整校验一个出站目标：形态 → 主机名 → 解析 → 逐地址分类。
 *
 * @param {string} raw
 * @param {{ lookup?: typeof dns.promises.lookup }} [deps]
 * @returns {Promise<{ ok: boolean, url?: URL, host?: string, ip?: string, reason?: string }>}
 */
export async function assertPublicTarget(raw, deps = {}) {
    const shape = checkTargetShape(raw);
    if (!shape.ok) return { ok: false, reason: shape.reason };

    const resolved = await resolveAndValidate(shape.host, deps);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    return { ok: true, url: shape.url, host: shape.host, ip: resolved.ip };
}

/**
 * 出站代理：连接前校验目标，并把连接**钉在已校验的 IP** 上。
 *
 * 与上游 `PrivateRequestAgent` 同构（`agent-base`），差别在于：
 *   · 地址分类更严（只放行公网单播，见 `classifyAddress`）；
 *   · 不改写入参对象，而是复制一份再覆盖 `host`（避免污染 agent 的池化键）；
 *   · HTTPS 保留 `servername`，否则 TLS 证书校验会拿 IP 去比对而失败。
 */
export class GuardedAgent extends Agent {
    /**
     * @param {object} [options]
     * @param {(msg: string) => void} [options.onBlocked] 拒绝时的回调（默认 console.error）
     */
    constructor(options = {}) {
        super({ keepAlive: false });
        this.onBlocked = options.onBlocked ?? ((msg) => console.error('[net-guard]', msg));
    }

    /**
     * @param {http.ClientRequest} _req
     * @param {import('agent-base').AgentConnectOpts} options
     */
    async connect(_req, options) {
        const host = options.host;
        if (!host) throw new Error('出站请求缺少主机名，已拒绝');

        const resolved = await resolveAndValidate(host);
        if (!resolved.ok) {
            this.onBlocked(`已拦截出站请求 → ${host}：${resolved.reason}`);
            throw new Error(resolved.reason);
        }

        const connectOptions = { ...options, host: resolved.ip };
        if (options.secureEndpoint && !connectOptions.servername) {
            connectOptions.servername = host;
        }
        return options.secureEndpoint ? tls.connect(connectOptions) : net.connect(connectOptions);
    }
}

/**
 * 用受控 agent 替换 Node 的全局出站 agent（上游 model 代理走 node-fetch，
 * 未显式传 agent 时用的就是它）。
 *
 * ── 本函数**可重复调用**（幂等）─────────────────────────────────────────────
 * 第一次调用安装并记住写入口；之后每次调用只是「重申」同一个受控 agent。
 * 为什么需要重申：上游 `src/server-main.js:109-110` 在启动链里**无条件**执行
 *   `http.globalAgent = new http.Agent({keepAlive: cliArgs.enableKeepAlive})`
 *   （https 同理）
 * 实测（真机 logcat）上游随后就覆盖掉了我们的 agent，故必须在启动链跑完之后
 * 重申一次；否则「装了防护」只是错觉。
 *
 * ── 两条实测结论（Node 24，决定本函数为何长这样）────────────────────────────
 * 1) **不能用 `Object.defineProperty` 把一个自造 getter/setter 直接换上去**：
 *    `http.globalAgent` 的 getter 只是「读」，真正让新 agent 生效的是原 setter
 *    （ClientRequest 里读的是 `options._defaultAgent || Agent.globalAgent`）。
 *    换掉访问器会切断传播链 —— `http.globalAgent` 看起来是新 agent（因为 getter
 *    是我们写的），真实出站请求却仍用旧 agent：防护不存在，而自测会**假绿**。
 *    正确做法：保留原访问器，只在其外层附加观察点。
 * 2) `http.globalAgent` 是访问器，但 `https.globalAgent` 是**数据属性**
 *    （实测 descriptor 只有 value/writable）。数据属性用「闭包 + 自造访问器」
 *    包一层后，HTTPS 请求同样会读到它（实测：环回目标被拦、错误信息为策略原因）
 *    —— 这条必须成立，因为所有模型端点都是 https。
 *
 * 替换方（上游若启用自带 private-request-filter 或出站代理）仍能正常生效，
 * 只是会多一条日志：白名单改由谁决定要说清楚，不能静默。
 */
const rawWriters = new Map();
let guardedAgent = null;

/**
 * @param {{ onReplaced?: (msg: string) => void, onBlocked?: (msg: string) => void }} [options]
 * @returns {GuardedAgent} 已安装（或已重申）的 agent
 */
export function installGuardedGlobalAgents(options = {}) {
    if (guardedAgent !== null) {
        for (const writeRaw of rawWriters.values()) writeRaw(guardedAgent);
        return guardedAgent;
    }

    const agent = new GuardedAgent({ onBlocked: options.onBlocked });
    const warnReplaced = options.onReplaced ?? ((msg) => console.warn('[net-guard]', msg));

    const installOn = (mod) => {
        const desc = Object.getOwnPropertyDescriptor(mod, 'globalAgent');
        const isAccessor = !!desc && typeof desc.get === 'function' && typeof desc.set === 'function';

        const readCurrent = () => (isAccessor ? desc.get.call(mod) : desc?.value);
        const writeRaw = isAccessor
            ? (next) => desc.set.call(mod, next)
            : (next) => {
                Object.defineProperty(mod, 'globalAgent', {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: next,
                });
            };

        const previous = readCurrent();
        if (previous === undefined) {
            throw new Error('http(s).globalAgent 不可读 —— 未安装受控出站 agent');
        }

        Object.defineProperty(mod, 'globalAgent', {
            configurable: true,
            enumerable: desc?.enumerable ?? true,
            get: readCurrent,
            set: (next) => {
                writeRaw(next); // 先传播：保证替换方真正生效
                if (next !== agent) {
                    warnReplaced('全局出站 agent 被替换 —— 出站白名单改由替换方决定，请确认其策略不弱于本模块');
                }
            },
        });

        rawWriters.set(mod, writeRaw);
        writeRaw(agent);
    };

    installOn(http);
    installOn(https);
    guardedAgent = agent;
    return agent;
}

// ---------------------------------------------------------------------------
// 二、来源（Origin）策略
// ---------------------------------------------------------------------------

/**
 * 允许的来源。
 *
 * · `https://localhost` —— App 自己的 WebView 页面（Capacitor `androidScheme: "https"`）。
 *   真机实测由启动日志与探针共同确认。
 * · `capacitor://localhost` —— Capacitor 在部分配置/平台下的 WebView 起源形态。
 *   留着它只为「换 scheme 不至于把 App 打死」；网上任意页面都无法获得该起源，
 *   故不扩大攻击面。
 * · 本机调试用来源（`localhost` / `127.0.0.1` 的任意端口）—— 桌面浏览器经
 *   `adb forward tcp:4444 tcp:4444` 访问设备后端时用到；允许它不额外扩大攻击面：
 *   能起本机 HTTP 服务并打开页面的一方，本来就能不经浏览器直接调本机 API。
 *
 * **不放行** `null`（沙箱 iframe / file:// / data: 页面），也不放行 `*`。
 */
const STATIC_ALLOWED_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

/**
 * @param {unknown} origin 请求头 `Origin` 原值
 * @returns {boolean} 是否放行
 */
export function isAllowedOrigin(origin) {
    if (typeof origin !== 'string' || origin === '') return false;
    if (origin === 'null') return false;
    if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;

    let url;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * 该响应应当发出的 `Access-Control-Allow-Origin` 值。
 *
 * @param {unknown} origin
 * @returns {string|null} 放行时回显该来源（绝不用 `*`）；不放行时 null（应删除/不设该头）
 */
export function corsAllowValue(origin) {
    return isAllowedOrigin(origin) ? String(origin) : null;
}
