/**
 * 学习产物「落盘」纯逻辑（Phase 4 / A' 终局）。// [SSA-LEARN]
 *
 * ── 职责边界 ──────────────────────────────────────────────────────────────
 * 本文件只做**纯变换**：建议 → 世界书条目、条目集合并/摘除。
 * 真正发起写请求的是壳（`suggest-gate.svelte.ts` 调 `worldbook.saveEntries()`），
 * 所以这里零 fetch / 零 DOM / 零 Svelte —— Node 可直接 import 做 G4 门禁。
 *
 * ── 为什么写进世界书而不是别处 ────────────────────────────────────────────
 * C-07：落盘**只走** `saveEntries()`（= ST 原生世界书格式），字段无损；
 * R-02：**不自动生效** —— 每条都要作者在确认闸里点「采纳」；关 flag 也不删已写条目。
 *
 * ── R-07（前缀块字节确定性）的落点 ────────────────────────────────────────
 * `assembler.ts` 里 `position === 0` 的条目进**前缀区**（冻结、追求缓存命中）。
 * 学习产物是「作者刚确认过的正文」，随时可能被再编辑，且不属于骨架语义，
 * 故本模块**固定写 `position: LEARNED_POSITION`（1 = 后置 → 尾缀区）**，
 * 绝不写 0；也**绝不**设 `extensions.static = true`（那是骨架成员标志，R-02）。
 * 两条都有 G4 断言钉住（含「该断言有分辨力」的反证）。
 */

import type { WorldInfoEntry } from '../context/assembler.ts';

/** 学习产物固定注入位置：1 = 后置（尾缀区），**永不为 0**（R-07）。 */
export const LEARNED_POSITION = 1;

/**
 * 落盘时写入的触发词个数上限。
 *
 * 为什么必须截：`candidateClusters.keywords` 是**整簇词表**（真实语料上可达数百个），
 * 全写进 `key` 会让条目「碰到任何一个词就整段注入」——等于把预算炸了。
 * 取前 N 个（词表已按文档频率降序）＝取最有代表性的场景词。
 */
export const LEARNED_MAX_KEYS = 6;

/** 默认目标世界书名（用户可在面板里改选已有书）。 */
export const DEFAULT_LEARNING_BOOK = '学习产物（实验）';

/** `extensions.learnedId` 的取值前缀，用于一眼看出条目来源。 */
export const LEARNED_ID_PREFIX = 'learned:';

/** 学习产物的稳定条目 id（撤销时按它摘除）。 */
export function learnedIdOf(uid: string): string {
  return `${LEARNED_ID_PREFIX}${uid}`;
}

/** 单条建议的落盘输入（壳从 `SuggestionItem` + 正文文本构造）。 */
export interface LearnedDraft {
  /** 台账 uid（`cluster:xxx` / `template:yyy`） */
  uid: string;
  title: string;
  /** 触发键（世界书 `key`） */
  keys: string[];
  /** 注入正文（世界书 `content`） */
  content: string;
  /** 来源种类，写进 extensions 供审计 */
  kind: 'cluster' | 'template';
}

/**
 * 哪些建议**可以**落盘。
 *
 * 只有携带可注入正文的两类进世界书：候选簇（keys = 簇关键词，正文 = 其模板行）
 * 与模板行（keys = 命中词，正文 = 模板文本）。
 * 另三类（场景触发 / 词对耦合 / 名称归并）是**观测性产物**，没有可注入正文，
 * 不进世界书 —— 这一点必须在 UI 里说清楚，不能让用户以为「采纳了却什么都没发生」。
 */
export const APPLIABLE_KINDS = ['cluster', 'template'] as const;

export function isAppliable(kind: string): boolean {
  return (APPLIABLE_KINDS as readonly string[]).includes(kind);
}

/** 建议 → 世界书条目（`key` 去重去空并截断到 `LEARNED_MAX_KEYS`；正文空白则不可落盘）。 */
export function toWorldbookEntry(d: LearnedDraft, at: string | null): WorldInfoEntry | null {
  const content = d.content.trim();
  if (!content) return null;
  const keys = [...new Set(d.keys.map((k) => k.trim()).filter(Boolean))].slice(0, LEARNED_MAX_KEYS);
  if (keys.length === 0) return null;
  const learnedId = learnedIdOf(d.uid);
  const entry: WorldInfoEntry = {
    uid: 0, // 由 toWorldbookData 按数组下标重编号（占位值，不参与语义）
    key: keys,
    content,
    comment: `[学习] ${d.title}`.slice(0, 120),
    position: LEARNED_POSITION,
    extensions: {
      learnedId,
      learnedKind: d.kind,
      learnedAt: at,
    },
  };
  return entry;
}

/**
 * 合并写回：先摘掉同一 `learnedId` 的旧条目（重复采纳 = 覆盖，不产生副本），
 * 再追加新条目。**不触碰**其它任何条目（社区世界书条目原样保留）。
 */
export function mergeLearnedEntry(
  existing: WorldInfoEntry[],
  entry: WorldInfoEntry,
): WorldInfoEntry[] {
  const id = entry.extensions?.learnedId;
  const kept = existing.filter((e) => e.extensions?.learnedId !== id);
  return [...kept, entry];
}

/** 摘除某条学习产物（撤销）。返回新数组与「是否真的摘到了」。 */
export function removeLearnedEntry(
  existing: WorldInfoEntry[],
  learnedId: string,
): { entries: WorldInfoEntry[]; removed: boolean } {
  const entries = existing.filter((e) => e.extensions?.learnedId !== learnedId);
  return { entries, removed: entries.length !== existing.length };
}

/** 该书里已有的学习产物条目数（UI 用于显示「本机已写入 n 条」）。 */
export function countLearnedEntries(existing: WorldInfoEntry[]): number {
  return existing.filter((e) => typeof e.extensions?.learnedId === 'string').length;
}
