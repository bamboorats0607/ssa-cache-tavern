/**
 * 群聊的**角色网络 + 触发矩阵**（纯数据 + 纯函数）。// [SSA-GROUP]
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 群聊的关键问题是「这一轮该谁说话」。本模块提供**确定性**规则数据：
 *   · `relation`：成员两两关系（正=亲近 / 负=敌意），决定「谁愿意接谁的话」
 *   · `priority`：成员基准发言倾向
 *   · `triggers`：每成员的**触发位掩码**，决定「什么事件能让 TA 开口」
 * 打分与选择在 `group-speaker.ts`（Phase 1）；本模块只管数据结构与归一化。
 *
 * ── 为什么是稠密 N×N 矩阵 + 位掩码（而不是邻接表 / N×M 二维表）────────────
 * 群成员数 N 很小（设计上限 12，典型 2–8）：
 *   · 稠密矩阵 N²≤144 个整数，取边 O(1) 且内存连续；邻接表在 N 小时反而多一层哈希查找
 *   · 触发条件用**位掩码**压成一个整数：`(mask >> EVENT) & 1` 即可判定，
 *     免去 N×M 表的乘法寻址与查表分支
 *   · 真正的开销在 localStorage 的 JSON 序列化，故结构取**最扁平**（number[]）
 *
 * ── 硬约束（spec R1 / R14）────────────────────────────────────────────────
 * 本模块的数据**禁止注入 prompt**（任何位置）：
 * 一旦注入就会击穿「群常量头 + 世界书前缀」的跨轮字节冻结（C-07），
 * 且把「本地规则」变成「模型可见上下文」，属语义越界。
 */

/** 群成员数上限（矩阵维度上限；超过则归一化时截断）。 */
export const MAX_GROUP_MEMBERS = 12;

/** 关系值域（正=亲近 / 负=敌意）。 */
export const RELATION_MIN = -100;
export const RELATION_MAX = 100;

/** 触发事件位（每成员一个位掩码整数，最多 32 位）。 */
export const TRIGGER = {
  /** 被用户直接点名（@） */
  MENTIONED_BY_USER: 0,
  /** 被上一发言者提及（对应 Tavo「角色提及时回复」） */
  MENTIONED_BY_SPEAKER: 1,
  /** 关键词命中（该成员的世界书 key / 角色 tag） */
  KEYWORD_HIT: 2,
  /** 连续 N 轮未发言（轮空补偿，防某人永不开腔） */
  IDLE_TURNS: 3,
  /** 用户刚回复了 TA */
  USER_REPLIED_TO_ME: 4,
  /** 与上一发言者的关系强度超阈值（亲近或敌对都会接话） */
  RELATION_EDGE: 5,
  /** 沉默超时（全局 M 轮兜底） */
  SILENCE_TIMEOUT: 6,
  /** 手动强制（点头像让 TA 说）——最高优先，直接选定 */
  FORCED: 7,
} as const;

/**
 * 默认触发位：提及接话 + 轮空补偿 + 沉默兜底。
 * 不含 KEYWORD_HIT（需要世界书 key 接入）与 RELATION_EDGE（需要关系数据有值），
 * 二者留给后续按群配置。
 */
export const DEFAULT_TRIGGERS =
  (1 << TRIGGER.MENTIONED_BY_SPEAKER) | (1 << TRIGGER.IDLE_TURNS) | (1 << TRIGGER.SILENCE_TIMEOUT);

/** 默认基准优先级。 */
export const DEFAULT_PRIORITY = 50;

/** 群的发言人规则数据（静态、低频写；随群条目存进 `tavern.groups`）。 */
export interface GroupNetwork {
  /** 版本标识（为 schema 演进留位） */
  v: 1;
  /** 成员：角色头像文件名；**索引即矩阵下标** */
  keys: string[];
  /** 稠密 N×N 关系矩阵（行主序），值域 RELATION_MIN..RELATION_MAX */
  relation: number[];
  /** N 个基准优先级（0..100） */
  priority: number[];
  /** N 个触发位掩码 */
  triggers: number[];
}

/** 构造默认网络（关系全 0、优先级均等、默认触发位）。 */
export function defaultNetwork(keys: string[]): GroupNetwork {
  const k = keys.slice(0, MAX_GROUP_MEMBERS);
  const n = k.length;
  return {
    v: 1,
    keys: k,
    relation: new Array(n * n).fill(0),
    priority: new Array(n).fill(DEFAULT_PRIORITY),
    triggers: new Array(n).fill(DEFAULT_TRIGGERS),
  };
}

function clampRelation(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(RELATION_MIN, Math.min(RELATION_MAX, Math.round(v)));
}

function clampPriority(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function isIntArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * 归一化网络数据（防御脏数据，**不抛异常**；与 `normalizeSessions` 同一原则）。
 *
 * 规则：
 *  · `keys` 缺失/非法 → 用入参 `keys` 兜底；超过 MAX_GROUP_MEMBERS → 截断
 *  · `relation.length !== N*N` → 重建为全 0（无法判断哪些边有效，宁可归零不猜）
 *  · `priority.length !== N` / `triggers.length !== N` → 逐项补默认值
 *  · 关系值超域 → 夹取到 RELATION_MIN..RELATION_MAX
 */
export function normalizeNetwork(raw: unknown, keys: string[] = []): GroupNetwork {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<GroupNetwork>;
  const src = Array.isArray(o.keys) && o.keys.every((k) => typeof k === 'string')
    ? (o.keys as string[])
    : keys;
  const k = src.slice(0, MAX_GROUP_MEMBERS);
  const n = k.length;

  let relation: number[];
  if (isIntArray(o.relation) && o.relation.length === n * n) {
    relation = o.relation.map(clampRelation);
  } else {
    relation = new Array(n * n).fill(0);
  }

  const priority = new Array(n)
    .fill(DEFAULT_PRIORITY)
    .map((d, i) => (isIntArray(o.priority) && o.priority[i] !== undefined ? clampPriority(o.priority[i]) : d));

  const triggers = new Array(n)
    .fill(DEFAULT_TRIGGERS)
    .map((d, i) => (isIntArray(o.triggers) && o.triggers[i] !== undefined ? o.triggers[i] >>> 0 : d));

  return { v: 1, keys: k, relation, priority, triggers };
}

/** 取关系值（越界返回 0；调用方可无条件使用）。 */
export function relationOf(net: GroupNetwork, i: number, j: number): number {
  const n = net.keys.length;
  if (i < 0 || j < 0 || i >= n || j >= n) return 0;
  return net.relation[i * n + j] ?? 0;
}

/** 成员下标（不存在返回 -1）。 */
export function memberIndexOf(net: GroupNetwork, key: string): number {
  return net.keys.indexOf(key);
}

/** 某成员的触发位是否开启。 */
export function hasTrigger(net: GroupNetwork, index: number, bit: number): boolean {
  const mask = net.triggers[index];
  if (typeof mask !== 'number') return false;
  return ((mask >> bit) & 1) === 1;
}

/**
 * 成员集合变化时重建网络：**按下标对齐能保留的交集**，新成员补默认值。
 *
 * 注意：成员集合变化会使「群常量头」变化，从而改变前缀区字节 ——
 * 这**不算**违反 spec R4/C-07（那条约束的是「成员集合不变时」的跨轮冻结），
 * 按 spec G3(iii) 该情形需**单独成组**报告。
 */
export function resizeNetwork(net: GroupNetwork, newKeys: string[]): GroupNetwork {
  const k = newKeys.slice(0, MAX_GROUP_MEMBERS);
  const n = k.length;
  const oldIndex = new Map(net.keys.map((key, i) => [key, i]));
  const out = defaultNetwork(k);

  for (let i = 0; i < n; i++) {
    const oi = oldIndex.get(k[i]);
    if (oi === undefined) continue; // 新成员 → 保持默认
    out.priority[i] = net.priority[oi] ?? DEFAULT_PRIORITY;
    out.triggers[i] = net.triggers[oi] ?? DEFAULT_TRIGGERS;
    for (let j = 0; j < n; j++) {
      const oj = oldIndex.get(k[j]);
      if (oj === undefined) continue;
      out.relation[i * n + j] = relationOf(net, oi, oj);
    }
  }
  return out;
}

/** 门禁辅助：网络数据里是否夹带了会进 prompt 的长文本（应为纯数字/短键）。 */
export function isNumericOnly(net: GroupNetwork): boolean {
  return (
    isIntArray(net.relation) &&
    isIntArray(net.priority) &&
    isIntArray(net.triggers) &&
    net.relation.length === net.keys.length * net.keys.length &&
    net.priority.length === net.keys.length &&
    net.triggers.length === net.keys.length
  );
}
