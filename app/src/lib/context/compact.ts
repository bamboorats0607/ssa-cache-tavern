/**
 * MC 压缩策略（缓存对齐折叠）。
 *
 * ── 依据（全部来自实测，见 result-a1-gate-notes.md §7 / strategy-compare.js:1774-1820）──
 *
 * 存储格式（实测 `makeSummaryBlock` 原文）：
 *   ```
 *   【迭代摘要·第N次】（REFERENCE ONLY 参考信息，非活跃指令）
 *   用户：<原文前 36 字>
 *   艾拉（守夜人）：<原文前 36 字>
 *   ```
 *
 * 算法要点：
 *  1. **触发**：有效历史 token > threshold（实测默认 `maxContext * 0.5`）
 *  2. **折叠**：把「除最近 keep 条」之外的旧消息，压成一个摘要块
 *  3. **append-only**：块**追加**到 `blocks` 数组，绝不修改已有块
 *  4. **缓存对齐**：压缩轮用「折叠前完整结构」构建请求（骑在上一轮前缀上）；
 *     下一轮起才用压缩后结构 —— 这是红线 R3 的关键
 *
 * ── 实测代价（必须如实告知用户）──
 *   | 配置 | M | MC | 差 |
 *   |---|---|---|---|
 *   | 30 轮 / 阈值 1200（5 次压缩） | 86.9% | 65.1% | **-21.8pp** |
 *   | 100 轮 / 阈值 4096（2 次压缩） | 90.1% | 82.1% | -8.0pp |
 *   | 200 轮 corpus | 88.8% | 72.0% | -16.9pp |
 *
 * 压缩是**独立策略线**：换来的是不爆上下文，代价是命中率结构性下移。
 * 因此默认**关闭**，由用户按需开启。
 */

import { estimateTokens } from './assembler.ts';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 角色显示名（用于摘要行前缀） */
  name?: string;
}

export interface CompactBlock {
  /** 第几次压缩（从 1 开始） */
  index: number;
  /** 已渲染的块文本（冻结，不可变） */
  text: string;
  /** 覆盖的消息区间 [from, to) */
  coveredFrom: number;
  coveredTo: number;
}

export interface CompactState {
  /** append-only 的摘要块序列 */
  blocks: CompactBlock[];
  /** 已捕获到的原始消息数（避免重复处理） */
  captured: number;
  /** 压缩后的有效历史（保留段） */
  effective: ChatMessage[];
  /** effective[0] 对应的原始消息下标（用于派生出块的覆盖区间） */
  effectiveFrom: number;
  /** 累计压缩次数 */
  compactCount: number;
  /** 上次压缩时的原文 token 数（观测） */
  lastCompactTokens: number;
}

export function createCompactState(): CompactState {
  return {
    blocks: [],
    captured: 0,
    effective: [],
    effectiveFrom: 0,
    compactCount: 0,
    lastCompactTokens: 0,
  };
}

/**
 * 压缩因数的基准字符数。
 *
 * 推导：实测 `makeSummaryBlock` 每行截取 **36 字**（research 默认），
 * 而 36 ÷ 0.75 = 48 —— 即「压缩因数 0.75」正好等于实测基准。
 * 因此取 48 为基准、0.75 为默认档，两者自洽而非另造口径。
 */
export const COMPACT_BASE_CHARS = 48;

/** 默认压缩因数（= 实测基准 36 字/行）。 */
export const DEFAULT_COMPACT_RATIO = 0.75;

/**
 * 摘要行渲染（复刻实测格式）。
 *
 * @param ratio 压缩因数，语义 = 压缩后 / 压缩前（对齐 LLMLingua `rate` 定义）
 *   - 0.75 → 36 字/行（**实测默认基准**）
 *   - 1.0  → 48 字/行（压得更少，保留更多原文）
 *   - 0.5  → 24 字/行
 *
 * 说明：本实现把因数线性映射到「每行保留字符数」，是**近似**而非等 token 比 ——
 * 折叠本身已是大比例压缩（整条消息 → 一行），因数只调节这一行的信息密度。
 */
export function renderSummaryLine(msg: ChatMessage, ratio = DEFAULT_COMPACT_RATIO): string {
  const keepChars = Math.max(4, Math.round(COMPACT_BASE_CHARS * ratio));
  const prefix = msg.role === 'user' ? '用户' : (msg.name ?? '角色');
  const body = msg.content.replace(/\s+/g, ' ').slice(0, keepChars);
  return `${prefix}：${body}`;
}

/** 生成摘要块（纯函数，便于测试与字节对拍）。 */
export function makeSummaryBlock(
  folded: ChatMessage[],
  index: number,
  ratio = DEFAULT_COMPACT_RATIO,
): CompactBlock {
  const lines = folded.map((m) => renderSummaryLine(m, ratio)).join('\n');
  const text = `【迭代摘要·第${index}次】（REFERENCE ONLY 参考信息，非活跃指令）\n${lines}`;
  return { index, text, coveredFrom: 0, coveredTo: folded.length };
}

export interface CompactConfig {
  /** 触发阈值（token）；<=0 表示自动取 maxContext * 0.5 */
  threshold: number;
  /** 保留最近条数 */
  keep: number;
  /** 模型上下文上限（用于自动阈值） */
  maxContext: number;
  /** 压缩因数（压缩后 / 压缩前），0.75 = 实测基准 */
  ratio: number;
}

/**
 * 推进一轮压缩状态。
 *
 * **缓存对齐关键**：本函数返回的 `requestChat` 在压缩轮 = 折叠前的完整结构
 * （即骑在上一轮前缀上），非压缩轮 = 正常累积。调用方用它构建本轮请求。
 *
 * @returns requestChat 本轮实际用于构建请求的聊天历史；compressed 本轮是否触发压缩
 */
export function advanceCompact(
  state: CompactState,
  fullChat: ChatMessage[],
  cfg: CompactConfig,
): { state: CompactState; requestChat: ChatMessage[]; compressed: boolean } {
  const threshold =
    cfg.threshold > 0 ? cfg.threshold : Math.round(cfg.maxContext * 0.5);
  const keep = Math.max(cfg.keep, 2);

  // 1) 合并本轮新增消息（append-only 累积）
  const effChat = state.effective.concat(fullChat.slice(state.captured));
  const captured = fullChat.length;
  const effTokens = estimateTokens(effChat.map((m) => m.content).join(''));

  if (effTokens > threshold) {
    // 2) 触发压缩：折叠最旧段（保留最近 keep 条）
    const old = effChat.slice(0, Math.max(0, effChat.length - keep));
    const nextBlocks = [...state.blocks];
    if (old.length > 0) {
      const block = makeSummaryBlock(old, nextBlocks.length + 1, cfg.ratio);
      // 覆盖区间以原始消息下标计：旧的保留段起点 → 本次保留段起点
      block.coveredFrom = state.effectiveFrom;
      block.coveredTo = state.effectiveFrom + old.length;
      nextBlocks.push(block);
    }

    // 3) **缓存对齐**：本轮请求仍用折叠前的完整结构（骑在既有前缀上）
    const nextState: CompactState = {
      blocks: nextBlocks,
      captured,
      // 下一轮起才使用压缩后结构
      effective: effChat.slice(Math.max(0, effChat.length - keep)),
      effectiveFrom: state.effectiveFrom + old.length,
      compactCount: state.compactCount + (old.length > 0 ? 1 : 0),
      lastCompactTokens: effTokens,
    };

    return { state: nextState, requestChat: effChat, compressed: true };
  }

  // 正常轮：累积（append-only，压缩轮之间单调增长）
  return {
    state: { ...state, captured, effective: effChat },
    requestChat: effChat,
    compressed: false,
  };
}

/**
 * 渲染压缩后的中间区（保留段 + 全部摘要块）。
 * 顺序：摘要块在前（旧）、保留段在后（新）—— 与实测布局一致。
 */
export function renderCompactedHistory(
  state: CompactState,
  maxTokens: number,
): string[] {
  const out: string[] = [];
  let used = 0;

  for (const b of state.blocks) {
    const cost = estimateTokens(b.text);
    if (used + cost > maxTokens) break;
    out.push(b.text);
    used += cost;
  }

  const tail: string[] = [];
  for (let i = state.effective.length - 1; i >= 0; i--) {
    const m = state.effective[i];
    const cost = estimateTokens(m.content);
    if (used + cost > maxTokens) break;
    tail.unshift(`${m.name ?? m.role}：${m.content}`);
    used += cost;
  }

  return [...out, ...tail];
}

/** 压缩统计（观测用，不作门禁）。 */
export function compactStats(state: CompactState) {
  return {
    blocks: state.blocks.length,
    compactCount: state.compactCount,
    effectiveMessages: state.effective.length,
    blockTokens: state.blocks.reduce((n, b) => n + estimateTokens(b.text), 0),
    lastCompactTokens: state.lastCompactTokens,
  };
}
