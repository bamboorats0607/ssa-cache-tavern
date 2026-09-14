# 里程碑：安卓壳网络策略（CORS 收敛 + 出站地址白名单）

- **状态**：完成（代码 + 真机验证；门禁 G7 未入库，见 §六）
- **代码落点**：`android/app/src/main/assets/nodejs-project/net-guard.js`（新增）、
  `…/main.js`（接线）、`…/config.yaml`（配置层收窄）、`scripts/prepare-backend.mjs`（保留清单）
- **验证设备**：真机（签名 release 构建），逐项结果见 §五
- **文档归档日**：2026-09-14

---

## 一、这一步修了什么

内嵌后端监听 `127.0.0.1:4444`，**没有任何鉴权**（上游单用户模式：`enableUserAccounts: false`，
中间件直接注入默认用户）。因此「谁能访问这个端口」就是全部边界。原状有两个缺口：

| # | 缺口 | 后果 |
|---|---|---|
| 1 | `cors.origin` 含 `"null"`（上游默认），且自研 fallback server 下发 `Access-Control-Allow-Origin: *` | 沙箱 iframe / `file://` / `data:` 页面拿到的 `Origin: null` 被放行 ⇒ **任意恶意网页都能读走本机后端响应** |
| 2 | `/api/backends/chat-completions/generate` 把请求体里的 `custom_url` **原样**当作出站目标（自研 fallback 代理同样如此） | 一个**无鉴权的 SSRF 原语**：以设备的内网视角访问 `127.0.0.1`、局域网、`169.254.169.254` 等 |

两者叠加 = 「用户点开一个恶意网页 → 该网页以内网视角扫描并读回结果」。单看任一条都还不致命，
合起来才成立，因此本步一次性修掉两条。

## 二、为什么强制点在 `main.js` 而不是 `config.yaml`

`MainActivity` 的行为不对称，这一条决定了实现层：

- `nodejs-project/`（含 `main.js`）**每次启动先删后建**，从 APK assets 重新解压 ⇒ 改代码会随 APK 生效；
- `filesDir/tavern/config.yaml` 只在**首启播种一次**，之后不再覆盖（保留用户改动）⇒ 改配置**不会**到达已安装设备。

所以：`config.yaml` 只负责「新装设备在配置层就一致」，**真正的强制点在 `main.js` + `net-guard.js`**。
若只改配置，已安装设备会「看起来改了、其实没改」——这类静默失效在本项目里已经吃过一次（见 §四.2）。

## 三、策略

`net-guard.js` 只做两件事，都是 **fail-closed**：

### 3.1 来源（Origin）白名单

放行：`https://localhost`（App 自己的 WebView，`androidScheme:"https"`）、
`capacitor://localhost`（换 scheme 的保险）、`http(s)://{localhost,127.0.0.1,::1}[:任意端口]`
（保留桌面浏览器经 `adb forward` 调试设备后端的能力 —— 能起本机 HTTP 服务的一方本来就能
不经浏览器直接调本机 API，故不额外扩大攻击面）。
**无 `Origin` 的请求一律放行**（`<img>`、原生 App、curl）；**`null` 与 `*` 一律不放行**。

两层执行：

- **请求层（权威）**：包装 `http/https.createServer` 的 handler 与 `Server.prototype.on/addListener/…`
  上的 `request` 监听器 —— 来源不合规时回 403 且**不调用**原监听器，Express 路由零执行，
  不存在「先产生副作用、再被拒掉」的窗口。本配置下上游 CSRF 是关闭的，请求层拦截才是真边界。
- **响应层（兜底）**：`setHeader`/`writeHead` 把 `Access-Control-Allow-Origin` **收敛为回显**或删除
  （绝不发 `*`/`null`），并把该响应改写成 403；同时保留既有的 CORP 改写（图片链路前提）。

### 3.2 出站地址白名单

只允许 `http:`/`https:`，且目标必须**解析到公网单播地址**：

- 拒绝：环回、私有、链路本地、运营商级 NAT、保留、组播、未指定、
  IPv4-mapped（`::ffff:127.0.0.1`）、NAT64（`64:ff9b::`）、6to4、Teredo、文档段、广播、
  以及 `localhost`/`*.local`/`*.internal`/`*.home.arpa` 等保留名；
- 判定用 `ipaddr.js` 的 `range()`，**只放行 `unicast`**（比手写 CIDR 表更不易漏 ——
  上游自带过滤器就漏了 `0.0.0.0/8`、`::/128`、`100.64/10`、`224/4`、`240/4`、IPv4-mapped）；
- DNS 解析后校验**每一个**地址（A 记录里混私网即整条拒绝）；
- 连接**钉在已校验的 IP** 上（消除「校验时公网、连接时环回」的 rebinding 时间窗）；
- 解析失败 → 拒绝（fail-closed）；
- 内嵌 URL 凭据（`http://user:pass@host/`）→ 拒绝。

## 四、交付过程中被实测推翻的三次设计（如实记录）

1. **patch `EventEmitter.prototype.emit` 会让整个服务端静默失效。**
   最初把请求层拦截挂在 `http.Server.prototype.emit`（想拿到「派发前」的钩子）。
   本机实测：一旦替换该函数，监听器**不再被派发** —— `listen()` 的回调不触发、
   `'request'` 也不到 Express，且没有任何异常。连一个朴素 `EventEmitter` 都能复现。
   改为包装 `createServer` 的 handler 与 `Server.prototype.on`，语义更窄也更稳。
2. **用 `defineProperty` 换掉 `http.globalAgent` 会切断传播链，防护变成错觉。**
   `http.globalAgent` 是模块导出上的**访问器**，真正让新 agent 生效的是它的 setter
   （`ClientRequest` 读的是 `options._defaultAgent || Agent.globalAgent`）。
   自造 getter/setter 会让 `http.globalAgent`「看起来」是新 agent（自测因此**假绿**），
   真实出站却仍走旧 agent。首版就是这么错的，且是**门禁里那条「真的发一个请求去环回端口」**
   的用例把它抓出来的 —— 只断言 `globalAgent === agent` 永远发现不了。
   另注：`https.globalAgent` 在这一版本是**数据属性**（不是访问器），需另一种包装方式。
3. **上游会覆盖全局 agent，必须重申。**
   真机 logcat 抓到我们自己的告警：「全局出站 agent 被替换」。
   根因是上游 `src/server-main.js:109-110` **无条件**执行
   `http.globalAgent = new http.Agent({ keepAlive: cliArgs.enableKeepAlive })`（https 同理）。
   故 `main.js` 在 `await bootUpstream()` 之后**重申**一次受控 agent；
   同时把「被替换」的告警留在日志里当金丝雀（不静默）。

配套：`scripts/prepare-backend.mjs` 的 `PRESERVE` 清单加入 `net-guard.js`，
使装配脚本在校验阶段就会报「手写文件丢失」——否则未来某次装配可能把防护文件悄悄带走。

## 五、真机验证（同一台设备、同一次启动）

| 项 | 手段 | 结果 |
|---|---|---|
| 启动链 | logcat `TavernNode` | 上游正常 listen 4444；先出现「agent 被替换」告警，重申后无二次告警 |
| 恶意来源 | `POST /api/characters/all` + `Origin: https://evil.example` | `403`，且响应无 `ACAO` |
| `null` 起源 | 同上 + `Origin: null` | `403`（旧配置放行） |
| App 来源 | 同上 + `Origin: https://localhost` | `200` + `ACAO: https://localhost`（回显，非 `*`） |
| 无来源 | 同上，不带 `Origin` | `200`，无 `ACAO` |
| 头像链路 | `GET /characters/<avatar>.png` | `200`、`image/png`、`CORP: cross-origin`；带恶意来源则 `403` |
| SSRF（环回） | `custom_url: http://127.0.0.1:4444/s5/health` | 被拦，理由「地址属于 loopback 段」；logcat 有拦截行 |
| SSRF（元数据） | `custom_url: http://169.254.169.254/…` | 被拦（linkLocal） |
| SSRF（私网） | `custom_url: http://10.0.0.1/…` | 被拦（private） |
| 无误报 | `custom_url: https://example.com/` | 未被策略拦（拿到对端自己的 405）⇒ 公网 https + TLS/SNI 正常 |
| App 可用 | 无障碍树（真实 DOM 文本） | 角色 `Seraphina`、世界书 `ELDORIA`、设置页全部区块正常渲染；logcat 中「已拒绝非授权来源」计数 **0** |

第一条 SSRF 探针是关键：`127.0.0.1:4444/s5/health` 本来**能**返回本进程健康 JSON，
被拦说明拦截发生在连接之前，而不是「碰巧连不上」。

## 六、门禁与残余风险

**门禁 G7（未随公开仓入库）**：114 项全通过 —— 32 类地址分类（含上述绕过形态）、
目标形态校验、假解析器注入（混合记录 / rebinding / 解析失败 / 括号 IPv6）、
Origin 矩阵（14 放行 + 12 拒绝）、行为层（403 零副作用、ACAO 收敛、`writeHead` 对象形态、
无来源放行、http+https 环回出站拦截、上游覆盖后重申仍拦截、外部替换仍能传播）。

**残余风险与代价（有意接受，如实登记）**：

1. **同机原生 App 可绕过**：它不受 CORS 约束，也能自带/省略 `Origin` 头。
   关闭这一条需要前后端共享密钥，上游没有该机制；且此类攻击者的权限本已高于本进程。
2. **局域网/本机自建模型端点从此被拒**（Ollama / LM Studio / llama.cpp 等）。
   这是「拒绝 localhost、环回、私有和保留地址」这条硬约束的直接推论，属功能取舍而非缺陷。
3. 上游若改用全局 `fetch`/undici（不经 `http.globalAgent`）发出站请求，本策略覆盖不到；
   当前上游用 node-fetch（走 `http.request`），已实测覆盖。
4. Mimosa 的 commit 钩子仍报 `scanner_no_output`；**不得**因此宣称项目安全。

## 七、仓库纪律

- 本次改动不含凭据、签名文件、第三方源码或构建产物；不含本机绝对路径。
- 门禁脚本与真机证据位于本机开发目录 `spikes/`（`.gitignore` 整目录排除），**未入库**，
  clone 本仓无法复现 §六 的数字。**门禁脚本不上传**。
- 上游代码零改动：全部强制点在自研的引导层与新增模块内。`net-guard.js` 亦是如此
  （它复用上游已有的 `ipaddr.js` / `agent-base` 依赖，未新增依赖）。
