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
  /**
   * 群聊上下文（**仅群聊传入**；不传 = 单角色路径，输出逐字节不变，见 spec R2/C-06）。// [SSA-GROUP]
   *
   * 传入时的块序（spec §4 Phase 1，不可调整）：
   *   `群常量头(冻结) → 世界书前缀(冻结) → 发言人卡(可变) → history → 尾缀`
   * 不传时的块序（既有单角色，保持不变）：
   *   `角色块 → 世界书前缀 → history → 尾缀`
   *
   * 注意两条硬约束：
   *  · `memberNames` **只放成员姓名名单**（禁止 description/personality/scenario/mes_example）—— R1/C-05
   *  · 关系矩阵 / 优先级 / 触发位**一律不得进入本结构**（spec R14）——它们只影响「谁说话」
   */
  group?: GroupContext;
}

/** 群聊组装所需的最小上下文（不含任何规则数据）。 */
export interface GroupContext {
  /** 全部成员显示名（群常量头用；顺序无关，内部会去重排序以保证字节稳定） */
  memberNames: string[];
  /** 本轮发言人显示名 */
  speakerName: string;
  /** 本轮发言人设定（可空；空则该块不注入，与单角色同规则） */
  speakerDescription?: string;
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
    group,
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
  const desc = charDescription?.trim();

  // 1) 首块：单角色 = 角色设定；群聊 = 群常量头（成员姓名名单，不含任何人设长文本）
  //    —— 这是两条路径**唯一**的块位差异；群聊多出的「发言人卡」在第 2.5 步插入。
  if (group) {
    // [SSA-GROUP]
    const head = renderGroupHead(group.memberNames);
    if (head) turns.push({ role: 'system', content: head });
  } else if (desc) {
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

  // 2.5) 群聊专属：发言人卡（**可变区**，放在冻结区之后、history 之前）
  //      形状与单角色角色块逐字同构，保证「模型眼中的发言人」与单角色一致。
  if (group) {
    // [SSA-GROUP]
    const card = renderSpeakerCard(group.speakerName, group.speakerDescription);
    if (card) turns.push({ role: 'system', content: card });
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
 * 群常量头：告诉模型「你在一个群里、都有谁」。
 *
 * **功能必需而非缓存优化**：若只把当前发言人当 `charName` 传入，模型不知道自己在群里、
 * 也不知道还有谁在场 —— 那不是群聊，只是「轮流单聊」。
 *
 * 两条约束（违反即返工）：
 *  · **只含成员姓名名单**，禁止任何 `description/personality/scenario/mes_example`（R1/C-05）；
 *  · 去重 + 排序后输出 → **成员集合不变时字节恒定**（C-07），与成员顺序无关。
 * 群名**刻意不入此块**：改名不应击穿冻结。
 */
export function renderGroupHead(memberNames: string[]): string {
  const names = [...new Set(memberNames.map((n) => n.trim()).filter(Boolean))].sort();
  if (names.length === 0) return '';
  return (
    `【群聊】你在一个有多名角色的群聊中，在场的有：${names.join('、')}。\n` +
    '你可以自然接话，也可以把话让给别人；不必每轮都发言。'
  );
}

/** 发言人卡：与单角色的角色块**同构**（仅当前发言人）。 */
export function renderSpeakerCard(speakerName: string, speakerDescription?: string): string {
  const desc = speakerDescription?.trim();
  if (!desc) return '';
  return `你正在扮演「${speakerName}」。角色设定：${desc}\n请始终保持这个角色的语气与性格进行对话。`;
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
