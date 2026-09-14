// Tavern 内嵌后端入口。
//
// 运行环境：Android 内的 nodejs-mobile（libnode Node 24），于后台线程启动。
// 职责：
//   1) 启动 SillyBunny 后端（复用上游 server-ref，零改动）
//   2) 若上游启动失败，降级为内置轻量 API（保证 App 可用）
//
// 关键约束（实测确立）：
//   - nodejs-mobile 不提供 child_process ⇒ 必须设 SILLYBUNNY_SUPERVISED=1
//     走 server.js 的逃生门，否则会尝试 spawn 子进程而失败。
//   - 必须在 JS 层设置 env（JNI 直调 node::Start 时 environ 继承自 zygote，
//     不含自定义变量）。
//   - process.exit() 会杀掉整个 App 进程，须拦截。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {
    assertPublicTarget,
    corsAllowValue,
    installGuardedGlobalAgents,
    isAllowedOrigin,
} from './net-guard.js';

const PORT = 4444;
const HOST = '127.0.0.1';
const startedAt = Date.now();

// 脚本所在目录的确定（按可靠性排序，逐级回退）：
//   1) TAVERN_BASE_DIR 环境变量（最高优先，便于调试覆盖）
//   2) import.meta.dirname —— ESM 标准，不依赖 argv 形态（本地实测可靠）
//   3) process.argv[1] 的目录 —— 本地实测 argv = [node, <script>, ...]
//   4) process.cwd() —— 最后兜底
//
// 历史 bug：早期写法取 slice(2) 的下标，两个取值都落空，
// baseDir 恒等于 cwd（设备上为 '/'）→ 永远找不到上游 server.js。
const scriptPath = process.argv[1];
void scriptPath;
const baseDir =
    process.env.TAVERN_BASE_DIR ||
    (typeof import.meta.dirname === 'string' ? import.meta.dirname : null) ||
    (scriptPath && fs.existsSync(scriptPath) ? path.dirname(scriptPath) : null) ||
    process.cwd();

console.log('[tavern] baseDir =', baseDir);
console.log('[tavern] node =', process.version, 'mobile =', process.versions.mobile ?? 'n/a');

// 网络策略在**上游加载之前**装好（顺序有语义）：
//   · 出站 agent 必须在任何出站请求发生前替换 globalAgent（上游的模型代理走
//     node-fetch，未显式传 agent 时用的就是它）；
//   · 入站响应策略必须在第一个请求被处理前 patch 好 ServerResponse。
// 详见 installNetworkPolicy() / net-guard.js 顶部说明。
installNetworkPolicy();

// ---------------------------------------------------------------------------
// 拦截 process.exit：nodejs-mobile 下会终止整个 App 进程（实测）。
// 上游 server-main.js 多处调用 process.exit(1) 于非致命场景。
// ---------------------------------------------------------------------------
const realExit = process.exit.bind(process);
void realExit;
process.exit = ((code) => {
    console.error(`[tavern] process.exit(${code}) 被拦截 —— 避免杀掉 App 进程`);
    if (code && code !== 0) {
        console.error('[tavern] 上游以非零码退出，降级为内置 API');
        startFallbackApi();
    }
    // 不真正退出
    return undefined;
});

// ---------------------------------------------------------------------------
// 降级：内置轻量 API（上游不可用时保证 App 仍可用）
//
// 关键职责：**代理** `/api/backends/chat-completions/generate`
//   前端（WebView，origin=https://localhost）只能访问本机 127.0.0.1:4444，
//   因此由本进程代它去访问真正的模型端点。这样做的三个好处：
//     1) 前端永远只认一个契约（与上游 SillyBunny 完全一致）
//     2) 绕开 WebView 的混合内容/跨域限制
//     3) 流式响应原样透传，前端 SSE 解析逻辑不因后端形态而变
//
// 代理目标的确定（与上游语义一致，chat-completions.js:2127）：
//   request.body.custom_url 优先；缺省时回退到环境变量 TAVERN_API_URL。
// 鉴权：接受 `custom_include_headers`（上游同名字段，chat-completions.js:2130），
//   例如 {"Authorization": "Bearer sk-xxx"}；若提供了 api_key 字段则自动补 Bearer。
// ---------------------------------------------------------------------------
let fallbackServer = null;

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 32 * 1024 * 1024) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

/**
 * 把 /generate 请求转发到真实模型端点，流式原样回传。
 * 返回前请勿再写响应（本函数负责收尾）。
 */
function proxyGenerate(req, res) {
    readJsonBody(req)
        .then(async (body) => {
            const target = body.custom_url || process.env.TAVERN_API_URL;
            if (!target) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    error: {
                        message: '尚未配置模型地址。请在「设置 → 连接」中填写 API 地址。',
                    },
                }));
                return;
            }

            // 出站白名单：仅 http/https，且目标必须解析到**公网单播**地址。
            // 不合法时在发请求之前就拒绝，文案要能指导用户改配置（而不是静默失败）。
            // 注意这里只是「早退一份友好错误」；真正的强制点在 GuardedAgent
            //（连接前校验并把连接钉在已校验 IP 上），二者对同一策略求值。
            const verdict = await assertPublicTarget(target);
            if (!verdict.ok) {
                console.warn(`[tavern] 已拦截代理目标 ${target} —— ${verdict.reason}`);
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    error: { message: `模型地址不被允许：${verdict.reason}` },
                }));
                return;
            }
            const targetUrl = verdict.url;

            // 组装发给模型端点的体：只保留标准 OpenAI 字段，剔除内部字段
            const {
                chat_completion_source, custom_url, custom_include_headers,
                user_name, char_name, group_names, cacheScope, log_prompts,
                type, api_key, ...rest
            } = body;
            void [chat_completion_source, custom_url, user_name, char_name,
                group_names, cacheScope, log_prompts, type];

            const headers = {
                'Content-Type': 'application/json',
                Accept: body.stream ? 'text/event-stream' : 'application/json',
            };
            if (custom_include_headers && typeof custom_include_headers === 'object') {
                for (const [k, v] of Object.entries(custom_include_headers)) {
                    if (typeof v === 'string') headers[k] = v;
                }
            }
            if (api_key && !headers.Authorization) {
                headers.Authorization = `Bearer ${api_key}`;
            }

            const payload = JSON.stringify(rest);
            const mod = targetUrl.protocol === 'https:' ? https : http;
            const upstream = mod.request(
                {
                    protocol: targetUrl.protocol,
                    hostname: targetUrl.hostname,
                    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                    path: targetUrl.pathname + targetUrl.search,
                    method: 'POST',
                    headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
                },
                (up) => {
                    console.log(`[tavern] proxy ${targetUrl.host} → ${up.statusCode}`);
                    // 原样透传状态码与内容类型（流式/非流式都适用）
                    res.writeHead(up.statusCode ?? 502, {
                        'Content-Type': up.headers['content-type'] ?? 'application/json; charset=utf-8',
                        'Cache-Control': 'no-cache, no-transform',
                    });
                    up.pipe(res);
                },
            );

            upstream.on('error', (e) => {
                console.error('[tavern] proxy error:', e?.message ?? e);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
                }
                res.end(JSON.stringify({
                    error: { message: `无法连接模型端点：${e?.message ?? e}` },
                }));
            });

            // 客户端断开时同步中断上游请求，避免连接泄漏
            req.on('aborted', () => upstream.destroy());

            upstream.write(payload);
            upstream.end();
        })
        .catch((e) => {
            console.error('[tavern] bad request:', e?.message ?? e);
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: '请求体解析失败' } }));
        });
}

function startFallbackApi() {
    if (fallbackServer) return;

    fallbackServer = http.createServer((req, res) => {
        const url = req.url ?? '/';
        // CORS 头：**绝不发 `*`** —— 回显已放行的来源；未放行则一个 CORS 头都不发
        //（installNetworkPolicy 的 setHeader 钩子还会再兜一层，这里保持一致以免误读）
        const allowOrigin = corsAllowValue(req.headers.origin);
        if (allowOrigin !== null) {
            res.setHeader('Access-Control-Allow-Origin', allowOrigin);
            res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const json = (obj, code = 200) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(obj));
        };

        if (url === '/s5/health' || url === '/tavern/health') {
            json({
                ok: true,
                mode: 'fallback',
                node: process.version,
                mobile: process.versions.mobile ?? null,
                platform: process.platform,
                arch: process.arch,
                uptimeMs: Date.now() - startedAt,
            });
            return;
        }

        // 内置 API 无 CSRF 保护；提供端点让前端逻辑统一（前端会带 token）
        if (url === '/csrf-token') {
            json({ token: 'disabled' });
            return;
        }

        if (url.startsWith('/api/characters')) {
            json({ characters: [], mode: 'fallback' });
            return;
        }

        // 核心：模型调用代理
        if (url.startsWith('/api/backends/chat-completions/generate')) {
            proxyGenerate(req, res);
            return;
        }

        json({ error: 'not_found', path: url, mode: 'fallback' }, 404);
    });

    fallbackServer.on('error', (e) => {
        console.error('[tavern] fallback server error:', e?.message ?? e);
    });
    fallbackServer.listen(PORT, HOST, () => {
        console.log(`[tavern] FALLBACK api listening on http://${HOST}:${PORT}`);
    });
}

// ---------------------------------------------------------------------------
// 入站响应策略：放开 CORP + CORS 收敛 + 来源（Origin）白名单
//
// 只 patch `http.ServerResponse.prototype` 的四个方法（setHeader / writeHead /
// write / end），上游源码零改动。策略本体在 net-guard.js（可单测）。
//
// ── (一) 放开 CORP（Cross-Origin-Resource-Policy）：图片链路的必要前提 ──
// 现象（真机实测）：`fetch('/api/characters/all')` 成功（角色名显示正常），
// 但头像 `<img>` 与背景 `--bg-art` 全部加载失败 → 界面只剩首字母兜底。
//
// 根因：上游 `server-main.js` 顶部 `app.use(helmet({contentSecurityPolicy:false}))`，
// helmet 默认下发 `Cross-Origin-Resource-Policy: same-origin`。
// 本应用的页面 origin 是 `https://localhost`（Capacitor androidScheme=https），
// 而后端在 `http://127.0.0.1:4444` —— 两者**跨源**。
// `<img>` / CSS `background-image` 属 no-cors 请求，不受 CORS 头影响，
// 但**受 CORP 约束**：响应声明 same-origin 时浏览器直接拒收（fetch 那侧因
// CORS 已放行故不受影响，这才出现「接口通、图片挂」的分裂）。
// 故这里把该类响应头改写为 `cross-origin`。
//
// ── (二) CORS 收敛：绝不发 `*`，也绝不放行 `null` ──
// 上游 config.yaml 的 cors.origin 里**曾经含 "null"**（沙箱 iframe、file://、
// data: 页面拿到的 Origin 就是 `null`）→ 任何恶意网页都能**读走**本机后端的响应
//（这正是「无鉴权 loopback SSRF」从「能打」升级为「能读回结果」的一环）。
// 现在：Access-Control-Allow-Origin 一律**回显**已放行的来源；未放行则删除该头
//（删除而非置空，避免出现 `ACAO:` 这种半吊子形态）。
//
// ── (三) 来源白名单：非本机 App 来源直接 403，且在**处理器之前** ──
// 两层保障：
//   1) 请求层（权威）：把 `request` 事件的监听器包一层 —— 来源不合规时回 403 且**不调用**
//      原监听器，因此 Express 路由零执行，不存在「先产生副作用、再被我们拒掉」的窗口。
//      上游 CSRF 在本配置下是关闭的（见 config.yaml 的威胁模型说明），
//      请求层拦截才是真正的边界。
//      挂载点：`http/https.createServer` 的 handler 参数 + `Server.prototype.on/addListener`。
//      **不要**改去 patch `EventEmitter.prototype.emit`：本 Node 版本实测该做法会让监听器
//      静默不再派发（连 `listen()` 回调都不触发），整个服务端失效。
//   2) 响应层（兜底）：万一响应仍被写出（例如某条路径绕过上面的包装），
//      setHeader/writeHead 会把 ACAO 收敛或删除，并把该响应改写成 403。
// 无 Origin 的请求（`<img>`、原生 App、curl、adb forward 调试）不受影响。
// 注意：Origin/CORS 只是**浏览器侧**防护 —— 同机原生 App 可自带/省略 Origin 头，
// 天然绕过，这一残余风险见 net-guard.js 顶部「它防护什么、不防护什么」。
// ---------------------------------------------------------------------------
function installNetworkPolicy() {
    // 出站：受控 agent 覆盖全局 agent（拒绝环回/私有/保留地址，见 net-guard.js）
    installGuardedGlobalAgents();

    const proto = http.ServerResponse.prototype;
    const origSetHeader = proto.setHeader;
    const origRemoveHeader = proto.removeHeader;
    const origWriteHead = proto.writeHead;
    const origWrite = proto.write;
    const origEnd = proto.end;

    /**
     * 回 403 并把该响应标记为「已处理」。
     * 故意绕过本文件 patch 过的方法（orig* 直调）—— 否则会被 (二)/(三) 的钩子吞掉。
     */
    const sendOriginForbidden = (res, origin, where) => {
        res.__tavernOriginScreened = true;
        res.__tavernOriginBlocked = true;
        console.warn(`[tavern] 已拒绝非授权来源 ${origin} → ${where}`);
        try {
            origSetHeader.call(res, 'Content-Type', 'application/json; charset=utf-8');
            origWriteHead.call(res, 403);
            origEnd.call(res, JSON.stringify({
                error: { message: '已拒绝来自非本机 App 来源的跨源请求' },
            }));
        } catch (e) {
            console.error('[tavern] 拒绝响应写入失败:', e?.message ?? e);
        }
    };

    /** 该请求的来源是否应被拒绝（无 Origin 视为放行）。 */
    const isOriginForbidden = (req) => {
        const origin = req?.headers?.origin;
        return origin !== undefined && !isAllowedOrigin(origin);
    };

    /**
     * 首次写响应时复核来源（兜底层）。
     * @returns {boolean} true = 已拒绝（已回 403），本次写入须作废
     */
    const screenOrigin = (res) => {
        if (res.__tavernOriginScreened === true) return res.__tavernOriginBlocked === true;
        res.__tavernOriginScreened = true;

        const req = res.req;
        if (!isOriginForbidden(req)) return false;

        sendOriginForbidden(res, req.headers.origin, `${req.method} ${req.url}`);
        return true;
    };

    // ── 请求层：包装 request 监听器，来源不合规时根本不调用它 ──
    const ORIGIN_GUARDED = Symbol.for('tavern.originGuarded');
    const guardRequestListener = (listener) => {
        if (typeof listener !== 'function' || listener[ORIGIN_GUARDED] === true) return listener;
        const guarded = function (req, res) {
            if (isOriginForbidden(req)) {
                sendOriginForbidden(res, req.headers.origin, `${req.method} ${req.url}`);
                return undefined;
            }
            return listener.call(this, req, res);
        };
        Object.defineProperty(guarded, ORIGIN_GUARDED, { value: true });
        return guarded;
    };

    for (const method of ['on', 'addListener', 'prependListener', 'once']) {
        const orig = http.Server.prototype[method];
        if (typeof orig !== 'function') continue;
        http.Server.prototype[method] = function (event, listener) {
            return event === 'request'
                ? orig.call(this, event, guardRequestListener(listener))
                : orig.call(this, event, listener);
        };
    }

    for (const mod of [http, https]) {
        const origCreateServer = mod.createServer;
        mod.createServer = function (...args) {
            return origCreateServer.apply(this, args.map(guardRequestListener));
        };
    }

    /** 按策略改写一组 writeHead 头对象（不改写入参对象）。 */
    const sanitizeCorsHeaders = (res, headers) => {
        if (!headers || typeof headers !== 'object') return headers;
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'access-control-allow-origin');
        if (key === undefined) return headers;
        const allow = corsAllowValue(res.req?.headers?.origin);
        const copy = { ...headers };
        if (allow === null) delete copy[key];
        else copy[key] = allow;
        return copy;
    };

    proto.setHeader = function (name, value) {
        if (typeof name === 'string') {
            const lower = name.toLowerCase();
            if (lower === 'cross-origin-resource-policy') {
                return origSetHeader.call(this, name, 'cross-origin');
            }
            if (lower === 'access-control-allow-origin') {
                if (screenOrigin(this)) return this;
                const allow = corsAllowValue(this.req?.headers?.origin);
                if (allow === null) {
                    return typeof origRemoveHeader === 'function'
                        ? origRemoveHeader.call(this, name)
                        : origSetHeader.call(this, name, '');
                }
                return origSetHeader.call(this, name, allow);
            }
        }
        if (screenOrigin(this)) return this;
        return origSetHeader.call(this, name, value);
    };

    proto.writeHead = function (statusCode, statusMessageOrHeaders, headers) {
        if (screenOrigin(this)) return this;
        return typeof statusMessageOrHeaders === 'string'
            ? origWriteHead.call(this, statusCode, statusMessageOrHeaders, sanitizeCorsHeaders(this, headers))
            : origWriteHead.call(this, statusCode, sanitizeCorsHeaders(this, statusMessageOrHeaders));
    };

    proto.write = function (...args) {
        // write() 的返回值是背压信号；被拒绝时按「已写入」返回，避免上游逻辑据此报错
        if (screenOrigin(this)) return true;
        return origWrite.apply(this, args);
    };

    proto.end = function (...args) {
        if (screenOrigin(this)) return this;
        return origEnd.apply(this, args);
    };
}

// ---------------------------------------------------------------------------
// 主路径：启动上游 SillyBunny 后端
// ---------------------------------------------------------------------------
async function bootUpstream() {
    const serverEntry = path.join(baseDir, 'server.js');
    if (!fs.existsSync(serverEntry)) {
        console.warn('[tavern] 未找到上游 server.js，使用内置 API');
        startFallbackApi();
        return;
    }

    // 关键：跳过 supervisor 的 spawn（nodejs-mobile 无 child_process）
    process.env.SILLYBUNNY_SUPERVISED = '1';
    process.env.NODE_ENV ??= 'production';
    // 上游 default/config.yaml 的 browserLaunch.enabled 默认为 true，
    // 其 server-main.js 会消费该变量。Android 下无浏览器可拉，不设则每次启动
    // 都会尝试 import('open')，属启动噪声与潜在异常源。
    process.env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH = '1';

    console.log('[tavern] 启动上游后端:', serverEntry);
    try {
        const mod = await import(serverEntry);
        console.log('[tavern] 上游后端已加载');
        void mod;
    } catch (e) {
        console.error('[tavern] 上游启动失败:', e?.stack ?? e);
        startFallbackApi();
    }
}

// 上游优先：必须先让上游尝试 bind 4444，仅在上游确实失败时才降级。
//
// 历史 bug（阻断级）：此处曾无条件先调用 startFallbackApi()，
// 它会立即 listen(4444)；而随后 await import(serverEntry) 会让出事件循环，
// 导致 fallback 的 bind 先完成 → 上游 server.js 用同一端口启动必然
// EADDRINUSE（retryOnAddressInUse 10×500ms 全部失败）→ #handleServerListenFail
// → process.exit(1) → 被本文件上方的拦截器吞掉 → 上游服务端从未 listen，
// 永远落入 fallback。症状酷似「内存不足」，极易误判方向。
//
// 降级的三条触发路径（均已覆盖）：
//   1) server.js 不存在            → bootUpstream 内 startFallbackApi()
//   2) import(server.js) 抛异常    → bootUpstream 内 startFallbackApi()
//   3) 上游启动链异步失败 exit(1)  → 上方 process.exit 拦截器 startFallbackApi()
//
// 注：网络策略（installNetworkPolicy）已在文件顶部调用，早于此处 —— 顺序有意义，
// 见该调用处的注释。
await bootUpstream();

// 必须在这里**重申**一次出站 agent：上游 `src/server-main.js:109-110` 在启动链里
// 无条件执行 `http.globalAgent = new http.Agent({keepAlive: ...})`（https 同理），
// 会把上面装好的受控 agent 覆盖掉（真机 logcat 实测：启动日志里出现了
// 「全局出站 agent 被替换」的告警）。不重申 = 模型代理链路实际无防护。
installGuardedGlobalAgents();

process.on('uncaughtException', (e) => {
    console.error('[tavern] uncaughtException:', e?.stack ?? e);
});
process.on('unhandledRejection', (e) => {
    console.error('[tavern] unhandledRejection:', e?.stack ?? e);
});
