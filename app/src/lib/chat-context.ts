/**
 * 聊天上下文组装（把内核产出物转成后端消息数组）。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────────────
 * 这段逻辑原先内联在 `ChatView.svelte` 里，导致两个问题：
 *   1) **无法测试** —— Svelte 组件的内部函数不能从外部 import，
 *      组装规则（前缀/历史/尾缀的顺序、统计口径）只能靠肉眼检查。
 *   2) 视图层混入业务规则，职责不清。
 * 抽成**纯函数**后：不依赖任何 store / DOM，可直接在 Node 里跑断言。
 *
 * ── 缓存友好序（本函数的核心不变量）──────────────────────────────────────
 * 输出顺序固定为 `system(角色) → system(世界书前缀) → history → system(尾缀)`：
 *   · 前缀区字节冻结 → 吃上游前缀缓存（命中价约为输入价 1/10）
 *   · 尾缀区每轮变化 → 必然 miss，故置于**最末**，不影响前面的稳定性
 * 这个顺序不可随意调整，否则缓存命中会崩。
 */

import {
  assembleContext,
  estimateTokens,
  type FactSlotState,
  type SsaConfig,
  type WorldInfoEntry,
} from './context/assembler.ts';
import type { ChatTurn, ContentPart } from './chat.ts';
import type { TurnStats } from './chat-stats.ts';

/**
 * 取消息内容的纯文本（数组时拼接所有 text 部件；图片不计）。
 *
 * 刻意为本地纯函数、不复用 `chat.ts` 的 `contentText`：本模块被 Node
 * strip-types 直接单测导入，引入 `chat.ts` 的 value import 会连带加载
 * fetch/logger 依赖图（且为无扩展名 import），导致单测无法运行。
 */
function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  let out = '';
  for (const part of content) {
    if (part.type === 'text') out += part.text;
  }
  return out;
}

export interface BuildContextInput {
  /** 世界书条目（可为空 → 只注入角色设定） */
  entries: WorldInfoEntry[];
  /** 会话历史（按时间正序） */
  history: { role: 'user' | 'assistant'; text: string; images?: string[] }[];
  /** 当前角色名 */
  charName: string;
  /** 当前角色设定（description） */
  charDescription?: string;
  /** 内核配置 */
  cfg: Partial<SsaConfig>;
  /** 事实槽状态（跨轮传入、跨轮传出） */
  factState?: FactSlotState;
  /** 随机源（注入以保证可测；生产用默认） */
  rng?: () => number;
  /** 扫描深度：参与关键词匹配的最近消息条数 */
  scanDepth?: number;
}

export interface BuildContextOutput {
  turns: ChatTurn[];
  stats: TurnStats;
  /** 更新后的事实槽状态，调用方需持久化并下轮传回 */
  factState?: FactSlotState;
}

/**
 * 组装本轮请求的消息数组与统计。
 *
 * @returns turns（发给模型）+ stats（展示在消息下方）+ 下一轮的 factState
 */
export function buildContext(input: BuildContextInput): BuildContextOutput {
  const {
    entries,
    history,
    charName,
    charDescription,
    cfg,
    factState,
    rng,
    scanDepth = 6,
  } = input;

  // 扫描文本：最近 N 条（对齐 ST 的 world_info_depth 语义）
  const scanText = history
    .slice(-scanDepth)
    .map((m) => m.text)
    .join('\n');

  const r = assembleContext({
    entries,
    scanText,
    history: history.map((m) => `${m.role}：${m.text}`),
    cfg,
    factState,
    rng,
  });

  const turns: ChatTurn[] = [];

  // 1) 角色设定（恒定，进最前面的 system）
  const desc = charDescription?.trim();
  if (desc) {
    turns.push({
      role: 'system',
      content: `你正在扮演「${charName}」。角色设定：${desc}\n请始终保持这个角色的语气与性格进行对话。`,
    });
  }

  // 2) 世界书前缀区（骨架，字节冻结 —— 缓存命中的主要来源）
  if (r.layers.prefix.length > 0) {
    turns.push({
      role: 'system',
      content: `【世界设定·恒定】\n${r.layers.prefix.join('\n')}`,
    });
  }

  // 3) 对话历史
  //    无图 → 保持纯字符串（字节与旧版完全一致，不破坏前缀缓存对齐）
  //    带图 → 部件数组：text 在前、图片在后（部件格式取证：openai.js:6150）
  for (const m of history) {
    const images = m.images?.filter((u) => typeof u === 'string' && u.length > 0) ?? [];
    if (images.length === 0) {
      turns.push({ role: m.role, content: m.text });
    } else {
      const parts: ContentPart[] = [
        { type: 'text', text: m.text },
        ...images.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
      ];
      turns.push({ role: m.role, content: parts });
    }
  }

  // 4) 尾缀区（活簇/事实槽/检索叶 —— 每轮变化，必须放最末）
  if (r.layers.suffix.length > 0) {
    turns.push({
      role: 'system',
      content: `【本轮相关设定】\n${r.layers.suffix.join('\n')}`,
    });
  }

  return {
    turns,
    factState: r.factState,
    stats: {
      // 先用本地估算占位；流式返回后由 API 实测值覆盖
      // 估算只计文本（数组形态时取所有 text 部件；图片不计 token）
      inputTokens: turns.reduce((n, t) => n + estimateTokens(textOf(t.content)), 0),
      outputTokens: 0,
      cachedTokens: 0,
      inputMeasured: false,
      breakdown: {
        prefix: r.layers.prefix.length,
        suffix: r.layers.suffix.length,
        liveClusters: r.stats.activatedClusters,
        facts: r.stats.factTokens,
        leaf: r.stats.leafTokens,
      },
    },
  };
}

/**
 * 把 API 实测用量合并进统计（覆盖本地估算）。
 *
 * 抽成独立函数的原因：估算值（本地）与实测值（API）来自两个时刻，
 * 合并规则需要单点定义，避免视图层各处重复实现导致口径不一致。
 */
export function mergeUsage(
  base: TurnStats,
  usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined,
  fallbackOutputText: string,
): TurnStats {
  return {
    ...base,
    inputTokens: usage?.promptTokens ?? base.inputTokens,
    outputTokens: usage?.completionTokens ?? estimateTokens(fallbackOutputText),
    cachedTokens: usage?.cachedTokens ?? 0,
    inputMeasured: usage?.promptTokens !== undefined,
  };
}
