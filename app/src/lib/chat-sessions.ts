/**
 * 对话（会话）的纯逻辑。
 *
 * ── 为什么从 store 里拆出来 ────────────────────────────────────────────────
 * `sessions.svelte.ts` 用了 Svelte 的 `$state` 运行时语法，Node 无法直接加载
 * （不是类型问题，无法用 strip-types 绕过）。而「淘汰策略 / 消息派生 / 载入
 * 归一化」这些是**纯函数**，拆出来后可在 Node 里直接跑断言。
 *
 * 这样分层也更清晰：
 *   · 本模块 = 与框架无关的对话数据结构与规则（可测）
 *   · sessions.svelte.ts = 响应式状态 + 持久化（不可单测，需浏览器）
 */

import type { TurnStats } from './chat-stats';

/** 单条对话保留的最大轮数（超出丢最旧）。 */
export const MAX_TURNS_PER_SESSION = 500;
/** 全局保留的最大对话条数（超出丢最旧）。 */
export const MAX_SESSIONS = 60;

/** 一轮对话的完整记录（同时承载「对话内容」与「用量」）。 */
export interface StoredTurn {
  id: string;
  /** 对话内轮次（从 1 递增） */
  round: number;
  /** 发生时间戳 */
  at: number;
  userText: string;
  assistantText: string;
  /** 用户消息附带的图片（data URL 数组，可为空） */
  images?: string[];
  /** 本轮耗时（毫秒，从发起请求到流结束） */
  durationMs: number;
  /** 本轮使用的模型名 */
  model: string;
  /** 用量（写入时已归一：无实测则用估算，并标 inputMeasured） */
  stats: TurnStats;
}

/** 一条对话（属于某个角色）。 */
export interface ChatSession {
  id: string;
  /** 归属角色名（上游无 id，见 sessions.svelte.ts 文件头「已知局限」） */
  characterName: string;
  /** 对话标题：默认取首条用户消息前 24 字，可被重命名覆盖 */
  title: string;
  /** 用户是否手动重命名过（是则不再自动改标题） */
  renamed: boolean;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
}

/** 对话恢复出的消息（与 ChatView 的渲染结构一致）。 */
export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  stats: TurnStats;
}

/** 未命名对话的占位标题。 */
export const UNTITLED = '新对话';

/** 按更新时间倒序（最新在前）。 */
export function byRecency(a: ChatSession, b: ChatSession): number {
  return b.updatedAt - a.updatedAt;
}

/** 淘汰：全局超限时丢最旧。 */
export function pruneSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort(byRecency).slice(0, MAX_SESSIONS);
}

/** 淘汰：单对话轮数超限时丢最旧。未超限时**原样返回**（避免无谓拷贝）。 */
export function pruneTurns(turns: StoredTurn[]): StoredTurn[] {
  if (turns.length <= MAX_TURNS_PER_SESSION) return turns;
  return turns.slice(turns.length - MAX_TURNS_PER_SESSION);
}

// ---------------------------------------------------------------------------
// 消息级撤销 / 截断（长按 / 右键菜单的操作语义）
//
// 这些是**纯函数**：不碰框架、不碰 store，只对 turns 做不可变变换。
// 与 pruneTurns 同一取向：未命中目标时**原样返回入参**，避免无谓拷贝。
// ---------------------------------------------------------------------------

/**
 * 截断：删除指定轮次及其**之后的所有**轮次（用于「撤销此消息及以下」）。
 *
 * @param turnId 目标轮次 id（不存在时原样返回，不报错）
 * @returns 新数组（不修改入参）；若删除到头则返回空数组
 */
export function truncateFrom(turns: StoredTurn[], turnId: string): StoredTurn[] {
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return turns;
  return turns.slice(0, idx);
}

/**
 * 撤销助手回复：把指定轮次的 assistantText 置空（**保留其 userText**），
 * 并删除其后所有轮次（用于「撤销此回复及以下」）。
 *
 * @param turnId 目标轮次 id（不存在时原样返回，不报错）
 * @returns 新数组（不修改入参）
 */
export function clearAssistantFrom(turns: StoredTurn[], turnId: string): StoredTurn[] {
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return turns;
  // 前面的轮次原样保留；目标轮保留 userText、清空 assistantText；其后全部丢弃
  return [...turns.slice(0, idx), { ...turns[idx], assistantText: '' }];
}

// ── 决策说明：为何不提供 replaceUserFrom ────────────────────────────────────
// 「改写并重新生成」的完整路径是「先 truncateFrom 丢弃该轮及其后 → 再以新文本
// 走与发送完全相同的生成路径（组装上下文 → 流式生成 → appendTurn 落盘）」。
// 新文本会作为**新的一轮**落盘，因此**不需要**先把旧轮次的 userText 改写留存。
// 多提供一个 replaceUserFrom 只会引入一个无处调用的死函数，故按最简实现省略。


/**
 * 由轮次派生消息列表。
 *
 * 对话内容**不单独存储** —— turns 里已含 userText/assistantText/stats，
 * 恢复时直接派生。好处：聊天气泡与统计页永远同源，不会两边对不上。
 */
export function messagesOf(session: ChatSession | null): StoredMessage[] {
  if (!session) return [];
  const out: StoredMessage[] = [];
  for (const t of session.turns) {
    out.push({ role: 'user', text: t.userText, stats: t.stats });
    out.push({ role: 'assistant', text: t.assistantText, stats: t.stats });
  }
  return out;
}

/** 某角色的全部对话（最新在前）。 */
export function listFor(all: ChatSession[], characterName: string): ChatSession[] {
  return all.filter((s) => s.characterName === characterName).sort(byRecency);
}

/**
 * 载入时归一化（防御外部/历史数据）。
 *
 * localStorage 里的内容可能来自旧版本或被人为修改，字段可能缺失。
 * 与内核的 normalizeEntries 同一原则：在边界处校验，让下游可无条件使用。
 */
export function normalizeSessions(raw: unknown): ChatSession[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
    .map((s) => ({
      id: String(s.id),
      characterName: typeof s.characterName === 'string' ? s.characterName : '未命名',
      title: typeof s.title === 'string' ? s.title : UNTITLED,
      renamed: s.renamed === true,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
      turns: Array.isArray(s.turns)
        ? s.turns
            .filter((t): t is StoredTurn =>
              !!t && typeof t === 'object' && !!(t as { stats?: unknown }).stats)
            // 图片为可选字段：非数组或元素非字符串一律丢弃（外部/旧数据防御）
            .map((t) => ({
              ...t,
              images: Array.isArray(t.images)
                ? t.images.filter((u): u is string => typeof u === 'string' && u.length > 0)
                : undefined,
            }))
        : [],
    }));
}
