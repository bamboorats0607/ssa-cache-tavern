/**
 * 活簇世界书：把「社区原版世界书」自适应转换为「特制活簇」。
 *
 * 背景（用户明确要求）：
 *   我们推翻了社区的上下文机制，因此社区世界书**不一定好用** —— 它们是为
 *   「逐条动态注入」设计的（策略 A，命中率仅 13.7%），没有静态/动态分层概念。
 *
 * 本模块职责：**自动**给未经标注的世界书补上 SSA 分层信息，使其直接受益于
 * M 策略（骨架-活簇，真命中 81.1%），而**不要求作者手工改造**。
 *
 * 三条自动转换规则（全部纯代码，零 LLM、零 embedding）：
 *   1. 静态识别：内容不含宏、不含时态/人称指代、长度稳定 ⇒ 骨架候选
 *   2. 簇聚类：按 key 共现/词形归并 ⇒ 生成 clusterId（同主题条目归为一簇）
 *   3. 冲突保护：若条目含宏或疑似时效内容，**不提升为骨架**，留活簇层
 *
 * 作者显式标注（extensions.static / extensions.clusterId）**永远优先**，
 * 自动推断只在字段缺失时生效（可关闭）。
 */

import {
  type WorldInfoEntry,
  hasMacro,
  estimateTokens,
  tokenizeBigrams,
  normalizeEntries,
} from './assembler.ts';

export interface ConversionReport {
  /** 被自动标记为骨架的条目 uid */
  autoSkeleton: number[];
  /** 被自动分配簇的条目：uid → clusterId */
  autoClusters: Record<number, string>;
  /** 因含宏/时效性而**拒绝**进骨架的条目 uid（保护性） */
  rejectedFromSkeleton: number[];
  /** 生成的簇统计 */
  clusterSizes: Record<string, number>;
}

/**
 * 时效性/动态性的启发式特征。
 * 命中任一 ⇒ 不进骨架（因为骨架要求会话内字节冻结）。
 */
const DYNAMIC_MARKERS = [
  /\{\{/,            // 宏（已在 hasMacro 覆盖，此处冗余保护）
  /今天|昨天|明天|现在|当前|此刻|刚才|马上|即将/,
  /第\s*\d+\s*[轮天日回]/,
  /好感度|亲密度|信任度|进度/,
  /HP|MP|血量|蓝量|等级|经验值/i,
];

/** 判断条目内容是否"动态"（不适合骨架）。 */
export function looksDynamic(content: string): boolean {
  if (!content) return true;
  if (hasMacro(content)) return true;
  return DYNAMIC_MARKERS.some((re) => re.test(content));
}

/**
 * 静态性评分（0~1，越高越适合骨架）。
 * 纯启发式，用于排序与阈值判定。
 */
export function staticityScore(entry: WorldInfoEntry): number {
  let score = 1;
  const c = entry.content ?? '';

  if (hasMacro(c)) score -= 0.8;
  if (looksDynamic(c)) score -= 0.5;

  // 长度：太短信息量不足，太长易含时效细节
  const tokens = estimateTokens(c);
  if (tokens < 8) score -= 0.3;
  if (tokens > 400) score -= 0.2;

  // constant 条目通常设定类（世界观/规则）⇒ 偏静态
  if (entry.constant) score += 0.2;

  // 明确非位置注入（position 0 前置）偏静态
  if (entry.position === 0) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * 簇聚类：把语义相近的条目归为一簇。
 *
 * 算法（零依赖，可测）：
 *   - 以条目的 key 集合构建倒排：key → uids
 *   - 共享 key 的条目归为同簇（并查集）
 *   - 无共享 key 的条目，用 key 的二元组相似度做二次合并（阈值可配）
 */
export function clusterEntries(
  entries: WorldInfoEntry[],
  simThreshold = 0.5,
): { clusters: Map<number, string>; sizes: Record<string, number> } {
  // 边界归一化：外部导入的条目可能缺 key 或 key 非数组（实测会抛 TypeError）
  const active = normalizeEntries(entries).filter((e) => !e.disable);
  const parent = new Map<number, number>();
  for (const e of active) parent.set(e.uid, e.uid);

  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // 路径压缩
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // 1) 共享 key 直接合并
  const byKey = new Map<string, number[]>();
  for (const e of active) {
    for (const k of e.key) {
      const key = (k ?? '').trim().toLowerCase();
      if (!key) continue;
      const arr = byKey.get(key) ?? [];
      arr.push(e.uid);
      byKey.set(key, arr);
    }
  }
  for (const uids of byKey.values()) {
    for (let i = 1; i < uids.length; i++) union(uids[0], uids[i]);
  }

  // 2) key 相似度二次合并（仅对尚未同簇的对，控制复杂度）
  const keyText = new Map<number, string>();
  for (const e of active) {
    keyText.set(e.uid, e.key.join(' ').toLowerCase());
  }
  const list = [...active];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].uid;
      const b = list[j].uid;
      if (find(a) === find(b)) continue;
      const sim = jaccardBigram(keyText.get(a) ?? '', keyText.get(b) ?? '');
      if (sim >= simThreshold) union(a, b);
    }
  }

  // 3) 生成稳定簇名（取簇内首个条目的首个 key，保证确定性）
  const rootToName = new Map<number, string>();
  const clusters = new Map<number, string>();
  const sizes: Record<string, number> = {};
  for (const e of list) {
    const root = find(e.uid);
    if (!rootToName.has(root)) {
      const seed = (e.key[0] ?? `cluster-${root}`).trim();
      rootToName.set(root, `auto:${seed}`);
    }
    const name = rootToName.get(root)!;
    // 单成员簇不生成 clusterId（避免无意义的簇）
    sizes[name] = (sizes[name] ?? 0) + 1;
    clusters.set(e.uid, name);
  }
  for (const [uid, name] of [...clusters]) {
    if ((sizes[name] ?? 0) < 2) clusters.delete(uid);
  }
  for (const name of Object.keys(sizes)) {
    if (sizes[name] < 2) delete sizes[name];
  }

  return { clusters, sizes };
}

function jaccardBigram(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = new Set(tokenizeBigrams(a));
  const sb = new Set(tokenizeBigrams(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const uni = sa.size + sb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

export interface ConvertOptions {
  /** 是否自动标记骨架（默认 true） */
  autoStatic?: boolean;
  /** 静态性阈值（默认 0.6） */
  staticityThreshold?: number;
  /** 是否自动生成簇（默认 true） */
  autoCluster?: boolean;
  /** 簇相似度阈值（默认 0.5） */
  clusterSimThreshold?: number;
}

/**
 * 转换结果记忆化。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────
 * 2026-09-12 性能实测：`convertToLiveCluster` 在 824 条规模下每次约 **372 ms**
 * （含 O(n²) 的簇相似度二次合并），且**无任何缓存** —— 只要调用方每轮重调，
 * 就每轮付一遍这个代价。而世界书在一个会话内是**不变的**，重复计算纯属浪费。
 *
 * ── 缓存键 ────────────────────────────────────────────────────────────────
 * 用 `WeakMap` 以**条目数组的引用**为键（外加选项签名）：
 *   - 调用方复用同一数组实例（加载一次、多轮复用）→ 命中，零成本
 *   - 调用方重新构造数组（内容可能已变）→ 未命中，正确重算
 * WeakMap 不阻止数组被 GC，无内存泄漏风险。
 */
const convertCache = new WeakMap<WorldInfoEntry[], Map<string, { entries: WorldInfoEntry[]; report: ConversionReport }>>();

function optionKey(o: Required<ConvertOptions>): string {
  return `${o.autoStatic}|${o.staticityThreshold}|${o.autoCluster}|${o.clusterSimThreshold}`;
}

/**
 * 主入口：把原版世界书转换为活簇世界书。
 *
 * **不修改原条目**（纯函数语义，返回新数组），作者标注优先。
 * 这样社区世界书导入后可直接转换，且随时可回退。
 *
 * 结果按「条目数组引用 + 选项」记忆化（见上方 convertCache 注释）；
 * 返回的是**缓存中的同一对象**，调用方不应就地修改返回值。
 */
export function convertToLiveCluster(
  entries: WorldInfoEntry[],
  opts: ConvertOptions = {},
): { entries: WorldInfoEntry[]; report: ConversionReport } {
  const autoStatic = opts.autoStatic ?? true;
  const autoCluster = opts.autoCluster ?? true;
  const staticThreshold = opts.staticityThreshold ?? 0.6;
  const simThreshold = opts.clusterSimThreshold ?? 0.5;

  // --- 记忆化查询 ---
  if (Array.isArray(entries)) {
    const key = optionKey({
      autoStatic,
      staticityThreshold: staticThreshold,
      autoCluster,
      clusterSimThreshold: simThreshold,
    });
    const cached = convertCache.get(entries)?.get(key);
    if (cached) return cached;
  }

  // 边界归一化（外部导入的 JSON 可能缺 key / key 非数组 / entries 为 undefined）
  const safe = normalizeEntries(entries);

  const report: ConversionReport = {
    autoSkeleton: [],
    autoClusters: {},
    rejectedFromSkeleton: [],
    clusterSizes: {},
  };

  // 先算簇（簇归属与静态判定独立，互不干扰）
  const clusterResult = autoCluster
    ? clusterEntries(safe, simThreshold)
    : { clusters: new Map<number, string>(), sizes: {} };
  report.clusterSizes = clusterResult.sizes;

  const out = safe.map((e) => {
    const ext = { ...(e.extensions ?? {}) };
    const wasExplicitStatic = ext.static !== undefined;
    const wasExplicitCluster = ext.clusterId !== undefined;

    // --- 规则 3：冲突保护（先判拒绝，避免误提升） ---
    if (autoStatic && !wasExplicitStatic) {
      if (looksDynamic(e.content)) {
        report.rejectedFromSkeleton.push(e.uid);
        ext.static = false;
      } else {
        // --- 规则 1：静态识别 ---
        const score = staticityScore(e);
        if (score >= staticThreshold) {
          ext.static = true;
          report.autoSkeleton.push(e.uid);
        } else {
          ext.static = false;
        }
      }
    }

    // --- 规则 2：簇聚类（作者显式优先） ---
    if (autoCluster && !wasExplicitCluster) {
      const cid = clusterResult.clusters.get(e.uid);
      if (cid) {
        ext.clusterId = cid;
        report.autoClusters[e.uid] = cid;
      }
    }

    return { ...e, extensions: ext };
  });

  const result = { entries: out, report };

  // --- 写回记忆化缓存 ---
  if (Array.isArray(entries)) {
    const key = optionKey({
      autoStatic,
      staticityThreshold: staticThreshold,
      autoCluster,
      clusterSimThreshold: simThreshold,
    });
    let byKey = convertCache.get(entries);
    if (!byKey) {
      byKey = new Map();
      convertCache.set(entries, byKey);
    }
    byKey.set(key, result);
  }

  return result;
}

/**
 * 反向：把活簇标注还原为原版世界书（可回退性）。
 * 仅剥离 SSA 命名空间字段，条目其余部分不动。
 */
export function revertToVanilla(entries: WorldInfoEntry[]): WorldInfoEntry[] {
  return entries.map((e) => {
    if (!e.extensions) return e;
    const ext = { ...e.extensions };
    delete ext.static;
    delete ext.clusterId;
    return { ...e, extensions: Object.keys(ext).length > 0 ? ext : undefined };
  });
}
