# ssa-cache-tavern

面向 **Prompt Cache 命中率优化** 的 AI 角色扮演客户端。

核心是一套名为 **SSA（Skeleton–Live-Cluster，骨架-活簇双层上下文法）** 的上下文装配机制：
把模型输入切成「前缀区 / 尾缀区」两段，让对话每轮都能骑在上一轮的缓存前缀上，
从而在长对话中把缓存命中率维持在高位。

配套一个 **Capacitor 跨端壳**，把前端与完整后端一起打进 APK，启动即用、离线自持。

---

## 缓存三红线

SSA 的正确性由三条不可破坏的约束保证（实现见 `app/src/lib/context/`）：

| 红线 | 内容 | 含义 |
|---|---|---|
| R1 | 前缀区字节级冻结 | 骨架条目一旦进入前缀，会话内**一个字节都不许变**，否则整段缓存失效 |
| R2 | 尾缀区每轮必 miss | 动态内容只进尾缀；miss 的根源是**位置**而非字节稳定性 |
| R3 | 压缩必须缓存对齐 | MC 迭代摘要 append-only，且压缩轮仍按折叠前结构请求，下一轮才切换 |

> 压缩（MC）是独立策略线：换来「不爆上下文」，代价是命中率结构性下移，因此默认关闭、由用户按需开启。

## 双轨兼容

- **Track A（原版）**：完全复刻 SillyTavern 世界书语义 —— 社区世界书直接可用。
- **Track B（SSA）**：骨架-活簇 + mft 事实槽 + mftr 检索叶。

作者只要给条目补上 `extensions.static` / `extensions.clusterId`，同一条目即自动升级为双层机制；
未标注的条目自动退回 Track A 行为。

---

## 目录结构

```
app/               自研前端（Svelte 5 + TS + Vite）
  src/lib/context/   SSA 上下文内核（装配 / 压缩 / 事实槽 / 活簇世界书）
  src/stores/        Svelte 5 runes 状态
  src/views/         页面
android/           Capacitor Android 工程（JNI 桥接 libnode）
scripts/           构建期装配脚本
```

## 构建

```bash
npm install
npm run release      # build:web → prepare:backend → cap sync → apk:release
```

仅构建前端：

```bash
npm --prefix app install
npm --prefix app run build
```

### 关于后端

`android/app/src/main/assets/nodejs-project/` 与 `android/app/libnode/` **不在本仓库**，
由 `scripts/prepare-backend.mjs` 在构建期从上游装配（体积约 400MB，且含 AGPL 第三方源码）。
复现完整 APK 需自行准备上游 SillyBunny 源码与 nodejs-mobile 预编译包，并放到脚本约定的位置。

---

## 第三方与许可

本仓库仅包含**自研代码**。以下内容**不在本仓库内**，各自遵循其原始许可：

- **SillyBunny / SillyTavern 后端**：上游项目，**AGPL-3.0**。本项目不 fork、不修改其端点语义，
  仅在构建期装配与内嵌调用。
- **nodejs-mobile 预编译运行时（libnode）**：上游二进制。

若你在本仓库之外分发构建产物（如 APK），需自行满足上游 AGPL-3.0 的相应义务。
