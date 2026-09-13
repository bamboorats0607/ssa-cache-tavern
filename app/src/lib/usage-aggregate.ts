/**
 * 用量聚合（统计页的数据核心）。
 *
 * 设计为**纯函数**：输入会话列表与筛选条件，输出聚合结果。
 * 不依赖 store / DOM，因此可以在 Node 里直接跑断言 —— 统计口径一旦写错，
 * 图表会「看起来正常但是错的」，比崩溃更危险。
 *
 * ── 三层隔离（用户要求）──────────────────────────────────────────────────
 *   1) 全部        —— 所有角色、所有会话
 *   2) 角色所有会话 —— 指定角色名下的全部会话
 *   3) 角色单会话   —— 指定会话
 * 用 `scope` 表达，聚合函数按 scope 过滤后再计算，保证三层口径完全一致。
 */

import type { ChatSession, StoredTurn } from './chat-sessions.ts';
import type { TurnStats } from './chat-stats.ts';

export type Scope =
  | { kind: 'all' }
  | { kind: 'character'; characterName: string }
  | { kind: 'session'; sessionId: string };

export interface Totals {
  /** 会话数 */
  sessions: number;
  /** 轮次数 */
  turns: number;
  /** 输入 token 合计 */
  input: number;
  /** 输出 token 合计 */
  output: number;
  /** 缓存命中 token 合计 */
  cached: number;
  /** 命中率 = cached / input（input 为 0 时取 0，避免 NaN） */
  hitRate: number;
  /** 未命中（计费）输入 = input - cached */
  missed: number;
  /** 总 token = input + output */
  total: number;
  /** 平均每轮输入 */
  avgInput: number;
  /** 平均每轮输出 */
  avgOutput: number;
  /** 平均每轮耗时（毫秒） */
  avgDurationMs: number;
  /** 数据来源：有多少轮是 API 实测（其余为估算） */
  measuredTurns: number;
  estimatedTurns: number;
  /** 时间范围 */
  firstAt: number | null;
  lastAt: number | null;
}

/** 折线图上的一个采样点（按轮次顺序）。 */
export interface SeriesPoint {
  /** 该轮在筛选结果中的序号（从 1 开始，用于 X 轴） */
  index: number;
  /** 时间戳 */
  at: number;
  input: number;
  output: number;
  cached: number;
  /** 该轮命中率 0~1 */
  hitRate: number;
  /** 该轮耗时（毫秒） */
  durationMs: number;
}

/** 按角色汇总（用于「全部」视角下的分布）。 */
export interface CharacterRollup {
  characterName: string;
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cached: number;
  hitRate: number;
}

/** 按会话汇总（用于角色视角下的会话列表）。 */
export interface SessionRollup {
  id: string;
  title: string;
  characterName: string;
  turns: number;
  input: number;
  output: number;
  cached: number;
  hitRate: number;
  updatedAt: number;
}

export interface Aggregate {
  /** 筛选后的会话（已按时间正序，便于画折线） */
  sessions: ChatSession[];
  /** 筛选后的轮次（按时间正序扁平） */
  turns: StoredTurn[];
  totals: Totals;
  /** 折线数据点 */
  series: SeriesPoint[];
  /** 按角色汇总（仅 scope=all 时非空） */
  byCharacter: CharacterRollup[];
  /** 按会话汇总（scope=character 时列出该角色会话） */
  bySession: SessionRollup[];
}

// ---------------------------------------------------------------------------
// 基础计算
// ---------------------------------------------------------------------------

/** 安全除法：分母 0 时返回 0（避免图表出现 NaN / Infinity）。 */
export function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** 单轮的派生指标。 */
function turnMetrics(t: StoredTurn) {
  const s: TurnStats = t.stats;
  return {
    input: s.inputTokens,
    output: s.outputTokens,
    cached: s.cachedTokens,
    measured: s.inputMeasured,
    durationMs: t.durationMs,
  };
}

/** 从一组轮次汇总出 Totals。 */
export function summarize(turns: StoredTurn[], sessionCount: number): Totals {
  let input = 0;
  let output = 0;
  let cached = 0;
  let duration = 0;
  let measured = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const t of turns) {
    const m = turnMetrics(t);
    input += m.input;
    output += m.output;
    cached += m.cached;
    duration += m.durationMs;
    if (m.measured) measured++;
    if (firstAt === null || t.at < firstAt) firstAt = t.at;
    if (lastAt === null || t.at > lastAt) lastAt = t.at;
  }

  const n = turns.length;
  return {
    sessions: sessionCount,
    turns: n,
    input,
    output,
    cached,
    hitRate: safeRate(cached, input),
    missed: Math.max(0, input - cached),
    total: input + output,
    avgInput: n > 0 ? Math.round(input / n) : 0,
    avgOutput: n > 0 ? Math.round(output / n) : 0,
    avgDurationMs: n > 0 ? Math.round(duration / n) : 0,
    measuredTurns: measured,
    estimatedTurns: n - measured,
    firstAt,
    lastAt,
  };
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

/** 按 scope 过滤会话。导出以便单测与 UI 复用。 */
export function filterSessions(all: ChatSession[], scope: Scope): ChatSession[] {
  switch (scope.kind) {
    case 'all':
      return all;
    case 'character':
      return all.filter((s) => s.characterName === scope.characterName);
    case 'session':
      return all.filter((s) => s.id === scope.sessionId);
  }
}

/** 把会话按时间正序展平为轮次序列（折线的 X 轴顺序）。 */
export function flattenTurns(sessions: ChatSession[]): StoredTurn[] {
  return [...sessions]
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((s) => s.turns);
}

// ---------------------------------------------------------------------------
// 汇总维度
// ---------------------------------------------------------------------------

function rollupCharacters(sessions: ChatSession[]): CharacterRollup[] {
  const map = new Map<string, CharacterRollup>();
  for (const s of sessions) {
    const cur = map.get(s.characterName) ?? {
      characterName: s.characterName,
      sessions: 0,
      turns: 0,
      input: 0,
      output: 0,
      cached: 0,
      hitRate: 0,
    };
    cur.sessions++;
    for (const t of s.turns) {
      const m = turnMetrics(t);
      cur.turns++;
      cur.input += m.input;
      cur.output += m.output;
      cur.cached += m.cached;
    }
    map.set(s.characterName, cur);
  }
  const out = [...map.values()];
  for (const r of out) r.hitRate = safeRate(r.cached, r.input);
  // 按输入量降序：消耗最大的角色排最前
  return out.sort((a, b) => b.input - a.input);
}

function rollupSessions(sessions: ChatSession[]): SessionRollup[] {
  const out = sessions.map((s) => {
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const t of s.turns) {
      const m = turnMetrics(t);
      input += m.input;
      output += m.output;
      cached += m.cached;
    }
    return {
      id: s.id,
      title: s.title,
      characterName: s.characterName,
      turns: s.turns.length,
      input,
      output,
      cached,
      hitRate: safeRate(cached, input),
      updatedAt: s.updatedAt,
    };
  });
  // 最近更新的排前面
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 聚合。
 *
 * @param all    全部会话
 * @param scope  三层隔离条件
 */
export function aggregate(all: ChatSession[], scope: Scope): Aggregate {
  const sessions = filterSessions(all, scope);
  const flat = flattenTurns(sessions);

  const series: SeriesPoint[] = flat.map((t, i) => {
    const m = turnMetrics(t);
    return {
      index: i + 1,
      at: t.at,
      input: m.input,
      output: m.output,
      cached: m.cached,
      hitRate: safeRate(m.cached, m.input),
      durationMs: m.durationMs,
    };
  });

  return {
    sessions,
    turns: flat,
    totals: summarize(flat, sessions.length),
    series,
    byCharacter: scope.kind === 'all' ? rollupCharacters(sessions) : [],
    bySession: scope.kind === 'all' ? [] : rollupSessions(sessions),
  };
}

/** 可选的折线指标。 */
export type MetricKey = 'input' | 'output' | 'cached' | 'hitRate' | 'durationMs';

export const METRICS: { key: MetricKey; label: string; unit: string; ratio?: boolean }[] = [
  { key: 'input', label: '输入', unit: 'tok' },
  { key: 'output', label: '输出', unit: 'tok' },
  { key: 'cached', label: '缓存命中', unit: 'tok' },
  { key: 'hitRate', label: '命中率', unit: '%', ratio: true },
  { key: 'durationMs', label: '耗时', unit: 'ms' },
];

/** 取某个指标在序列上的值（ratio 型乘 100）。 */
export function metricValue(p: SeriesPoint, key: MetricKey): number {
  const raw = p[key];
  const def = METRICS.find((m) => m.key === key);
  return def?.ratio ? raw * 100 : raw;
}
