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
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

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
        .then((body) => {
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

            let targetUrl;
            try {
                targetUrl = new URL(target);
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: { message: `模型地址无效：${target}` } }));
                return;
            }

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
        res.setHeader('Access-Control-Allow-Origin', '*');
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
// 放开 CORP（Cross-Origin-Resource-Policy）—— 图片链路的必要前提
//
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
//
// 改法：上游 helmet 是硬编码、无配置开关，且纪律要求**不改上游源码**，
// 故在我们的引导层（本文件）改写该类响应头的值 —— 只动这一项，不引入中间件。
// 影响面仅限本进程的 HTTP 响应；App 自身页面资产由 Capacitor 的
// https://localhost 服务提供，不经过此处。
// ---------------------------------------------------------------------------
function relaxCrossOriginResourcePolicy() {
    const origSetHeader = http.ServerResponse.prototype.setHeader;
    http.ServerResponse.prototype.setHeader = function (name, value) {
        if (typeof name === 'string' && name.toLowerCase() === 'cross-origin-resource-policy') {
            return origSetHeader.call(this, name, 'cross-origin');
        }
        return origSetHeader.call(this, name, value);
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
relaxCrossOriginResourcePolicy();
await bootUpstream();

process.on('uncaughtException', (e) => {
    console.error('[tavern] uncaughtException:', e?.stack ?? e);
});
process.on('unhandledRejection', (e) => {
    console.error('[tavern] unhandledRejection:', e?.stack ?? e);
});
