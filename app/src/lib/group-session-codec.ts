/**
 * 群聊会话的**纯逻辑**编解码层（Phase 0 / T0.1）。// [SSA-GROUP]
 *
 * ── 为什么单独成模块（与 `chat-sessions.ts` 同一取向）──────────────────────
 * store（`stores/groups.svelte.ts`）用了 Svelte 的 `$state` 运行时语法，Node 无法加载。
 * 而「格式映射 / 载入归一化 / 淘汰 / 禁图检测」都是**纯函数**，拆出来即可在 Node 直跑断言。
 * 分层：
 *   · 本模块 = 与框架无关的群会话数据结构与规则（可测）
 *   · stores/groups.svelte.ts = 响应式状态 + 持久化（需浏览器）
 *
 * ── 为什么需要「编解码」而不直接 JSON.stringify（A 升级分支的缝）────────────
 * 终局裁决取 B（记录只落本地独立键），但**存储格式与内存结构解耦**是有意的：
 * 将来若启动 A 升级分支（记录改由后端 `/api/chats/group/*` 承载），只需替换本模块的
 * 编解码实现 + store 的读写目标，上层（组装 / UI / 状态机）零改动。
 * 因此本模块自带 `v` 版本标识，且**不含任何 DOM / localStorage / fetch 依赖**。
 *
 * ── 硬约束（违反即返工，对应 spec R3 / C-03）───────────────────────────────
 * 群聊记录**禁止携带 data URL 图片**：`GroupTurn` 结构上就没有 `images` 字段，
 * 并提供 `hasInlineImageData()` 供门禁断言记录字节不含 `data:image/`。
 */

import type { TurnStats } from './chat-stats';

/** 本地持久化格式版本（为 schema 演进留位；载入时不匹配则按未知格式丢弃）。 */
export const GROUP_CODEC_VERSION = 1;

/** 每群保留的最大轮数（显式上限，**不套用**单角色的 MAX_TURNS_PER_SESSION 隐式语义）。 */
export const MAX_GROUP_TURNS = 200;
/** 全局保留的最大群会话条数。 */
export const MAX_GROUP_SESSIONS = 20;

/** 群聊里单条成员回复（每条 = 一次 API 调用）。 */
export interface GroupReply {
  id: string;
  /** 发言人：角色头像文件名（与群成员键 memberKeys 同一命名空间） */
  speakerKey: string;
  text: string;
  /** 该条回复的用量（实测优先，缺失时为本地估算） */
  stats: TurnStats;
  durationMs: number;
  model: string;
}

/**
 * 群聊一轮 = 用户一次发送 + 该轮所有成员回复。
 * 注意：**没有 images 字段**（R3/C-03 结构性禁止）。
 */
export interface GroupTurn {
  id: string;
  /** 会话内轮次（从 1 递增，按「用户一次发送」计） */
  round: number;
  at: number;
  /** 用户这一轮说的话（可为空字符串：纯「让某人说话」触发时） */
  userText: string;
  /** 本轮各成员的回复，按发言顺序 */
  replies: GroupReply[];
  /**
   * 本轮发言人选择的原因（本地状态机输出，仅 UI 提示与调试用）。
   * **禁止注入 prompt**（spec R14）：它属于本地规则元数据，不是模型可见上下文。
   */
  pickReason?: string;
}

/** 一条群会话记录（`tavern.groupSessions` 的条目）。 */
export interface GroupSessionRecord {
  /** 版本标识 */
  v: number;
  id: string;
  /** 归属群（`tavern.groups` 里的群 id） */
  groupId: string;
  title: string;
  /** 用户是否手动重命名过（是则不再自动改标题） */
  renamed: boolean;
  createdAt: number;
  updatedAt: number;
  turns: GroupTurn[];
}

/** 未命名群会话的占位标题。 */
export const UNTITLED_GROUP_SESSION = '新群聊';

/** 归一化单个用量对象（缺失字段补 0，防止下游 `undefined` 参与算术）。 */
function normalizeStats(raw: unknown): TurnStats {
  const s = (raw ?? {}) as Partial<TurnStats>;
  const b = (s.breakdown ?? {}) as Partial<TurnStats['breakdown']>;
  return {
    inputTokens: typeof s.inputTokens === 'number' ? s.inputTokens : 0,
    outputTokens: typeof s.outputTokens === 'number' ? s.outputTokens : 0,
    cachedTokens: typeof s.cachedTokens === 'number' ? s.cachedTokens : 0,
    inputMeasured: s.inputMeasured === true,
    breakdown: {
      prefix: typeof b.prefix === 'number' ? b.prefix : 0,
      suffix: typeof b.suffix === 'number' ? b.suffix : 0,
      liveClusters: typeof b.liveClusters === 'number' ? b.liveClusters : 0,
      facts: typeof b.facts === 'number' ? b.facts : 0,
      leaf: typeof b.leaf === 'number' ? b.leaf : 0,
    },
  };
}

/** 归一化单条回复；`speakerKey` 缺失则丢弃（发言人未知的回复无法渲染归属）。 */
function normalizeReply(raw: unknown): GroupReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.speakerKey !== 'string' || !r.speakerKey) return null;
  return {
    id: typeof r.id === 'string' ? r.id : `gr_${String(r.speakerKey)}_${String(r.at ?? '')}`,
    speakerKey: r.speakerKey,
    text: typeof r.text === 'string' ? r.text : '',
    stats: normalizeStats(r.stats),
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
    model: typeof r.model === 'string' ? r.model : '',
  };
}

/** 归一化单轮；无有效回复的轮次仍保留（用户发了话但没人接，也是有效历史）。 */
export function normalizeGroupTurn(raw: unknown, index: number): GroupTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const replies = Array.isArray(t.replies)
    ? t.replies.map(normalizeReply).filter((r): r is GroupReply => r !== null)
    : [];
  const out: GroupTurn = {
    id: typeof t.id === 'string' ? t.id : `gt_${index}`,
    round: typeof t.round === 'number' ? t.round : index + 1,
    at: typeof t.at === 'number' ? t.at : Date.now(),
    userText: typeof t.userText === 'string' ? t.userText : '',
    replies,
  };
  // 无值时**不造键**：归一化不得凭空引入字段（否则「字段无损」的往返断言会失真，
  // 且 deepStrictEqual 会把 {x: undefined} 与 {} 判为不同）
  if (typeof t.pickReason === 'string' && t.pickReason) out.pickReason = t.pickReason;
  return out;
}

/** 载入时归一化（防御外部/历史数据；与 `normalizeSessions` 同一原则）。 */
export function normalizeGroupSession(raw: unknown): GroupSessionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;
  if (typeof s.groupId !== 'string' || !s.groupId) return null;
  const turns = Array.isArray(s.turns)
    ? s.turns.map((t, i) => normalizeGroupTurn(t, i)).filter((t): t is GroupTurn => t !== null)
    : [];
  return {
    v: GROUP_CODEC_VERSION,
    id: s.id,
    groupId: s.groupId,
    title: typeof s.title === 'string' && s.title ? s.title : UNTITLED_GROUP_SESSION,
    renamed: s.renamed === true,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
    turns,
  };
}

/** 批量归一化（保持入参顺序）。 */
export function normalizeGroupSessions(raw: unknown): GroupSessionRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeGroupSession).filter((s): s is GroupSessionRecord => s !== null);
}

/** 编码为持久化字符串（**唯一**落盘入口，便于将来整体替换为后端承载）。 */
export function encodeGroupSessions(list: GroupSessionRecord[]): string {
  return JSON.stringify(list);
}

/** 从持久化字符串解码；损坏数据返回空数组（不抛异常）。 */
export function decodeGroupSessions(raw: string | null): GroupSessionRecord[] {
  if (!raw) return [];
  try {
    return normalizeGroupSessions(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 淘汰：单会话轮数超限时丢最旧。未超限时**原样返回**（避免无谓拷贝）。 */
export function pruneGroupTurns(turns: GroupTurn[]): GroupTurn[] {
  if (turns.length <= MAX_GROUP_TURNS) return turns;
  return turns.slice(turns.length - MAX_GROUP_TURNS);
}

/** 按更新时间倒序（最新在前）。 */
export function byGroupRecency(a: GroupSessionRecord, b: GroupSessionRecord): number {
  return b.updatedAt - a.updatedAt;
}

/** 淘汰：全局超限时丢最旧。 */
export function pruneGroupSessions(list: GroupSessionRecord[]): GroupSessionRecord[] {
  return [...list].sort(byGroupRecency).slice(0, MAX_GROUP_SESSIONS);
}

/**
 * 轮数显式计数（T1.2 要求群会话对 GroupTurn 显式计数，
 * 避免沿用单角色「turns.length 即轮数」的隐式语义被误改）。
 */
export function countGroupTurns(record: GroupSessionRecord): number {
  return record.turns.length;
}

/** 群会话内的成员回复总条数（用于 UI 展示「N 轮 · M 条发言」）。 */
export function countGroupReplies(record: GroupSessionRecord): number {
  return record.turns.reduce((n, t) => n + t.replies.length, 0);
}

/**
 * 门禁辅助：记录字节中是否含内联图片（`data:image/`）。
 * 用于断言 R3/C-03（群记录禁带图）——按**字节**判定，而非只看结构字段，
 * 这样即便有人绕过类型塞进来也能被检出。
 */
export function hasInlineImageData(record: GroupSessionRecord | string): boolean {
  const text = typeof record === 'string' ? record : JSON.stringify(record);
  return text.includes('data:image/');
}
