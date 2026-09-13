/**
 * 上下文机制内核（双轨）。
 *
 * 依据：`docs/骨架活簇双层上下文法-实证研究报告.md` §4.4 + `infra-research/arpm-dynamic-retrieval.md`
 *
 * 实测结论（决定了实现形态）：
 *  - M 策略（骨架-活簇）= 真命中 81.1%，为"动态灵活"类最优
 *  - 骨架放**前缀区**（每轮命中，成本≈0）；活簇放**尾缀区**（每轮必 miss，成本=字节×轮数）
 *  - S==S' 铁律：尾缀 miss 根源是**位置**而非字节稳定性
 *  - mft 事实槽：append-only 前置冻结块，实体源=世界书 key（宏键剔除）
 *  - mftr 检索叶：尾缀独立消息，实测代价 -1~-2pp
 *
 * 双轨设计（用户要求：与社区原版世界书**兼容**）：
 *  - Track A「原版」：完全复刻 SillyTavern 世界书语义（key 匹配 / constant / 概率 / 深度）
 *    —— 社区世界书直接可用，不作任何假设
 *  - Track B「SSA」：骨架-活簇 + mft 事实槽 + mftr 检索叶 + 活簇世界书
 *    —— 需要作者标注 static / clusterId；未标注的条目自动退回 Track A 行为
 *
 * 兼容关键：Track B 的**输入**就是 Track A 的条目集。也就是说，
 * 社区世界书无需改装即可跑；一旦作者补了 `extensions.static` / `extensions.clusterId`，
 * 同一条目自动升级为双层机制。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 世界书条目（对齐 SillyTavern 语义，字段名保持一致以便互操作）。 */
export interface WorldInfoEntry {
  uid: number;
  /** 主键（逗号分隔，兼容 ST 的多 key 形态） */
  key: string[];
  /** 次级键（ST 语义：与主键同段命中才激活） */
  keysecondary?: string[];
  content: string;
  comment?: string;
  /** 常驻（不依赖 key 命中） */
  constant?: boolean;
  /** 触发概率 0-100 */
  probability?: number;
  /** 注入顺序 */
  order?: number;
  /** 注入位置：0=前置 1=后置 2=AN前 3=AN后 4=@D 5=EM */
  position?: number;
  /** @D 深度 */
  depth?: number;
  disable?: boolean;
  /**
   * SSA 扩展命名空间（与 ST 的 entry.extensions 兼容）。
   * - static: true ⇒ 标记为骨架成员（进前缀区，字节冻结）
   * - clusterId: string ⇒ 归属簇；任一成员 key 命中则整簇激活
   */
  extensions?: {
    static?: boolean;
    clusterId?: string;
    [k: string]: unknown;
  };
}

/** 事实槽状态（append-only，冻结后字节恒定）。 */
export interface FactSlotState {
  facts: string[];
  seen: Set<string>;
  entities: string[];
  block: string;
  frozen: boolean;
  round: number;
}

export interface ContextLayers {
  /** 前缀区（冻结，追求命中）：黄金前缀 + 骨架 */
  prefix: string[];
  /** 消息区（追加式，天然命中）—— 由调用方填充，此处仅占位 */
  history: string[];
  /** 尾缀区（每轮付一次小 miss）：活簇 + 事实槽 + 检索叶 + 摘要 + AN */
  suffix: string[];
}

export interface SsaConfig {
  /**
   * 模型上下文上限（token）。骨架/活簇预算帽的**真实基数**。
   *
   * 必须与实际模型窗口一致：预算帽 = (预算百分比/100) × maxContext。
   * 默认 8192 与 model store 的 `maxContext` 默认值对齐。
   */
  maxContext: number;
  /** 冻结窗轮数（研究报告默认 6） */
  skeletonWindowRounds: number;
  /** 骨架/动态预算百分比（研究报告默认 30/70） */
  skeletonBudgetPct: number;
  liveBudgetPct: number;
  /** 事实槽预算（token） */
  factSlotMaxTokens: number;
  /** 事实槽冻结：'content' 按条数 | 'timer' 按轮数 | 'both' */
  freezeMode: 'content' | 'timer' | 'both';
  /** facts 达到该数量即冻结 */
  factsMax: number;
  /** 轮数达到即冻结 */
  warmupRounds: number;
  /** 检索叶预算（token） */
  retrievalLeafTokens: number;
  /** 压缩时保留最近条数（实测默认 6） */
  compactKeep: number;
  /** 压缩因数（压缩后 / 压缩前），0.75 = 实测基准 36 字/行 */
  compactRatio: number;
  /** 各机制开关（默认关，逐项启用便于 A/B） */
  enabled: {
    /** 骨架-活簇双层（M 策略） */
    skeletonLive: boolean;
    /** 事实槽 */
    factSlot: boolean;
    /** 检索叶 */
    retrievalLeaf: boolean;
    /** 活簇世界书（世界书自适应转活簇） */
    liveClusterWorldbook: boolean;
  };
}

export const DEFAULT_SSA_CONFIG: SsaConfig = {
  maxContext: 8192,
  skeletonWindowRounds: 6,
  skeletonBudgetPct: 30,
  liveBudgetPct: 70,
  factSlotMaxTokens: 200,
  freezeMode: 'content',
  factsMax: 12,
  warmupRounds: 5,
  retrievalLeafTokens: 200,
  compactKeep: 6,
  compactRatio: 0.75,
  enabled: {
    skeletonLive: false,
    factSlot: false,
    retrievalLeaf: false,
    liveClusterWorldbook: false,
  },
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * CJK 字符判定（含中日韩表意文字、假名、全角标点、CJK 扩展平面）。
 * 用 `u` 标志以便 `\u{...}` 匹配超出 BMP 的扩展区。
 */
const CJK_RE = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{2F800}-\u{2FA1F}\u{30000}-\u{3134F}]/u;

/**
 * 估算 token 数。
 *
 * ── 为什么不能用一个固定比率 ──────────────────────────────────────────────
 * 2026-09-12 用真实 API（deepseek-v4-flash-0731）反标定实测：
 *   | 文本类型 | 实测 tok/字符 | 旧实现（0.75 固定）偏差 |
 *   |---|---|---|
 *   | 纯中文    | 0.787 | −4.5%（准）|
 *   | 中文长条目 | 0.773 | −3.0%（准）|
 *   | 纯英文    | 0.197 | **+280%（严重高估）**|
 *   | 中英混合  | 0.606 | +24%（高估）|
 *
 * 依据（联网最佳实践）：各 tokenizer 对 CJK 与拉丁文的 chars/token 差异极大
 * （英文 ~4 chars/token，CJK ~1.5-2 chars/token），单一比率无法同时适配；
 * 且「工程上用经验估算做容量规划，用实际 API usage 做精确计费」。
 *
 * ── 本实现 ────────────────────────────────────────────────────────────────
 * 按字符类别加权（CJK / 非 CJK），比率取自上述实测：
 * 对中文保持准确（本项目主场），对英文不再高估 3.8 倍 ——
 * 高估虽"安全"（不会爆窗），但会白白浪费上下文额度并触发过早裁剪。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }

  // CJK 0.78 tok/字符（实测 0.773~0.787）；非 CJK 取 0.30 tok/字符。
  // 非 CJK 取 0.30 而非纯英文实测的 0.197，是为覆盖标点/数字/代码等更高密度情形，
  // 保留保守余量（宁可略高估，不可低估导致爆窗）。
  return Math.ceil(cjk * 0.78 + other * 0.3);
}

/** 宏检测：`{{...}}` 形态。骨架区禁止宏（依据 §4.4 宏规则）。 */
export const MACRO_RE = /\{\{[\s\S]*?\}\}/;

export function hasMacro(text: string): boolean {
  return MACRO_RE.test(text);
}

/** 剥离宏（用于把带宏条目降级到活簇区）。 */
export function stripMacros(text: string): string {
  return text.replace(new RegExp(MACRO_RE.source, 'g'), '');
}

/** 条目是否可进骨架：显式 static + 无宏 + 非禁用。 */
export function canBeSkeleton(entry: WorldInfoEntry): boolean {
  if (entry.disable) return false;
  if (entry.extensions?.static !== true) return false;
  // 宏禁入骨架（代码级拒绝，依据 §4.4）
  if (hasMacro(entry.content)) return false;
  if (entry.key.some((k) => hasMacro(k))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 边界归一化（外部输入防护）
// ---------------------------------------------------------------------------

/**
 * 归一化外部导入的世界书条目。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────
 * 世界书是**外部输入**（用户导入的 JSON，社区格式并不统一）。2026-09-12
 * 可靠性探针实测 17 项畸形输入，6 项直接抛 TypeError：
 *   - 缺 `key` 字段      → `e.key is not iterable`（collectFactEntities /
 *                          clusterEntries / convertToLiveCluster 三处崩溃）
 *   - `key: null`        → 同上
 *   - `entries: undefined` → `Cannot read properties of undefined (reading 'filter')`
 *
 * 另有一类**静默错误**：`key: '字符串键'`（误写成字符串而非数组）会被当数组迭代，
 * 产出 `['字','符','串','键']` 这样的单字实体 —— 不崩溃，但结果是错的。
 *
 * 因此在内核入口统一归一化：把 key/keysecondary 规范成字符串数组，
 * 剔除空项，保证下游可以无条件迭代。这是「在系统边界校验」原则的落地。
 *
 * @returns 归一化后的新数组（不修改入参）
 */
export function normalizeEntries(entries: WorldInfoEntry[] | undefined | null): WorldInfoEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e): e is WorldInfoEntry => !!e && typeof e === 'object')
    .map((e) => {
      // key / keysecondary 统一为「去空字符串后的字符串数组」
      const toKeyArray = (v: unknown): string[] => {
        if (Array.isArray(v)) {
          return v.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
        }
        // 非数组（含误写成字符串）：字符串按整体作为**单个** key，而非拆成单字
        if (typeof v === 'string' && v.trim() !== '') return [v];
        return [];
      };
      return {
        ...e,
        key: toKeyArray(e.key),
        keysecondary:
          e.keysecondary === undefined ? undefined : toKeyArray(e.keysecondary),
        content: typeof e.content === 'string' ? e.content : '',
      };
    });
}

// ---------------------------------------------------------------------------
// Track A：原版世界书语义（社区兼容路径）
// ---------------------------------------------------------------------------

/**
 * 关键词匹配（复刻 ST 的核心语义，简化为可测的纯函数）。
 * - 主键：任一命中即候选
 * - 次级键：存在时也必须命中
 * - constant：跳过 key 检查
 */
export function matchesKeys(entry: WorldInfoEntry, text: string): boolean {
  if (entry.disable) return false;
  if (entry.constant) return true;
  if (!entry.key || entry.key.length === 0) return false;

  const lower = text.toLowerCase();
  const primaryHit = entry.key.some((k) => k && lower.includes(k.toLowerCase()));
  if (!primaryHit) return false;

  if (entry.keysecondary && entry.keysecondary.length > 0) {
    const secondaryHit = entry.keysecondary.some(
      (k) => k && lower.includes(k.toLowerCase()),
    );
    if (!secondaryHit) return false;
  }
  return true;
}

/**
 * 概率判定（可注入 rng，保证确定性 —— 对齐 S1 spike 的 mulberry32 接管）。
 */
export function passesProbability(
  entry: WorldInfoEntry,
  rng: () => number,
): boolean {
  const p = entry.probability;
  if (p === undefined || p === null || p >= 100) return true;
  if (p <= 0) return false;
  return rng() * 100 < p;
}

/** 按 order 升序（ST 默认）排序。 */
export function sortByOrder(entries: WorldInfoEntry[]): WorldInfoEntry[] {
  return [...entries].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

// ---------------------------------------------------------------------------
// Track B：SSA 骨架-活簇
// ---------------------------------------------------------------------------

export interface SkeletonPlan {
  /** 进前缀区的骨架条目（按簇聚合） */
  skeleton: WorldInfoEntry[];
  /** 需按激活判定注入尾缀的活簇成员 */
  liveCandidates: WorldInfoEntry[];
  /** 簇 → 成员 uid 映射 */
  clusters: Map<string, number[]>;
  /** 未归属任何簇、也非骨架的普通条目（走 Track A 行为） */
  plain: WorldInfoEntry[];
}

/**
 * 规划骨架/活簇分区。
 *
 * 规则（依据 §4.4）：
 *  - 有 clusterId 且成员可进骨架 → 骨架
 *  - 有 clusterId 但成员含宏 → 活簇候选（宏只在活簇层）
 *  - 无 clusterId → plain（走原版行为，保证社区世界书可用）
 */
export function planSkeleton(entries: WorldInfoEntry[]): SkeletonPlan {
  const skeleton: WorldInfoEntry[] = [];
  const liveCandidates: WorldInfoEntry[] = [];
  const plain: WorldInfoEntry[] = [];
  const clusters = new Map<string, number[]>();

  for (const e of entries) {
    const cid = e.extensions?.clusterId;
    if (!cid) {
      plain.push(e);
      continue;
    }
    // 登记簇成员
    const members = clusters.get(cid) ?? [];
    members.push(e.uid);
    clusters.set(cid, members);

    if (canBeSkeleton(e)) {
      skeleton.push(e);
    } else {
      liveCandidates.push(e);
    }
  }

  return { skeleton, liveCandidates, clusters, plain };
}

/**
 * 激活判定：任一簇成员 key 命中 → 整簇激活。
 * 返回应注入尾缀的活簇条目。
 *
 * ⚠️ 必须逐条跳过 disable 成员。
 * 反面教训（2026-09-12 缺陷复现）：planSkeleton 登记簇成员时不看 disable，
 * 被禁用的条目照样进 clusters；而 canBeSkeleton 因 !disable 为假把它挡在骨架外，
 * 于是它落进 liveCandidates。此处若不再校验一次，禁用条目就会随整簇激活被注入
 * —— 表现为「世界书里明确关掉的设定仍在生效」。
 */
export function activateClusters(
  plan: SkeletonPlan,
  entries: WorldInfoEntry[],
  text: string,
): WorldInfoEntry[] {
  const byUid = new Map(entries.map((e) => [e.uid, e]));
  const activated: WorldInfoEntry[] = [];
  const activatedClusters = new Set<string>();

  // 先找被命中的簇
  for (const [cid, uids] of plan.clusters) {
    const hit = uids.some((uid) => {
      const m = byUid.get(uid);
      return m ? matchesKeys(m, text) : false;
    });
    if (hit) activatedClusters.add(cid);
  }

  // 整簇注入：被激活簇的**全部**成员（含骨架成员之外需动态注入的部分）
  for (const e of plan.liveCandidates) {
    if (e.disable) continue; // 禁用条目永不注入（含随簇激活）
    const cid = e.extensions?.clusterId;
    if (cid && activatedClusters.has(cid)) activated.push(e);
  }
  return activated;
}

/**
 * 双层预算裁剪。
 * 骨架区与动态区各自独立帽；超预算从排序末尾裁（先裁后注入，会话内固定）。
 */
export function trimToBudget(
  entries: WorldInfoEntry[],
  budgetTokens: number,
): WorldInfoEntry[] {
  const sorted = sortByOrder(entries);
  const out: WorldInfoEntry[] = [];
  let used = 0;
  for (const e of sorted) {
    const cost = estimateTokens(e.content);
    if (used + cost > budgetTokens) break;
    out.push(e);
    used += cost;
  }
  return out;
}

// ---------------------------------------------------------------------------
// mft 事实槽（append-only 前置冻结块）
// ---------------------------------------------------------------------------

/**
 * 实体源 = 世界书 key（复数形态展开），剔除宏键。
 * 依据 arpm-dynamic-retrieval.md §任务注意点 1。
 */
export function collectFactEntities(entries: WorldInfoEntry[]): string[] {
  const set = new Set<string>();
  for (const e of normalizeEntries(entries)) {
    for (const k of e.key) {
      const key = (k ?? '').trim();
      if (!key) continue;
      if (hasMacro(key)) continue; // 宏键剔除
      set.add(key);
    }
  }
  return [...set];
}

export function createFactSlotState(entities: string[]): FactSlotState {
  return { facts: [], seen: new Set(), entities, block: '', frozen: false, round: 0 };
}

/**
 * 共现抽取：实体在文本中出现即产出证据片段（idx-6 ~ idx+24）。
 * append-only：已产出的 facts 永不修改（红线 R1）。
 */
export function updateFactSlot(
  state: FactSlotState,
  text: string,
  cfg: Pick<SsaConfig, 'freezeMode' | 'factsMax' | 'warmupRounds' | 'factSlotMaxTokens'>,
): FactSlotState {
  if (state.frozen) {
    return { ...state, round: state.round + 1 };
  }

  const facts = [...state.facts];
  const seen = new Set(state.seen);

  for (const ent of state.entities) {
    if (seen.has(ent)) continue;
    const idx = text.indexOf(ent);
    if (idx < 0) continue;
    const snippet = text.slice(Math.max(0, idx - 6), Math.min(text.length, idx + 24));
    facts.push(`· ${ent}：${snippet}`);
    seen.add(ent);
  }

  let frozen = false;
  if (cfg.freezeMode === 'content') frozen = facts.length >= cfg.factsMax;
  else if (cfg.freezeMode === 'timer') frozen = state.round >= cfg.warmupRounds;
  else frozen = facts.length >= cfg.factsMax || state.round >= cfg.warmupRounds;

  const block = renderFactBlock(facts, cfg.factSlotMaxTokens);

  return { facts, seen, entities: state.entities, block, frozen, round: state.round + 1 };
}

/**
 * 渲染事实块。行粒度截断，**保留前缀**（字节单调，不破坏前缀冻结）。
 * 依据 arpm-dynamic-retrieval.md：`trimFactBlockToBudget` 语义。
 */
export function renderFactBlock(facts: string[], maxTokens: number): string {
  const header = '【事实槽·REFERENCE ONLY】';
  const lines: string[] = [header];
  let used = estimateTokens(header);
  for (const f of facts) {
    const cost = estimateTokens(f);
    if (used + cost > maxTokens) break;
    lines.push(f);
    used += cost;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// ---------------------------------------------------------------------------
// mftr 检索叶（尾缀独立消息）
// ---------------------------------------------------------------------------

/** 中文二元组切分（BM25-like 词法近似）。 */
export function tokenizeBigrams(text: string): string[] {
  const clean = text.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    out.push(clean.slice(i, i + 2));
  }
  return out;
}

/** 词法相关度（共现率，统一 idf 简化）。 */
export function lexicalScore(query: string, doc: string): number {
  const q = tokenizeBigrams(query);
  if (q.length === 0) return 0;
  const d = new Set(tokenizeBigrams(doc));
  let hit = 0;
  for (const t of new Set(q)) {
    if (d.has(t)) hit++;
  }
  return hit / new Set(q).size;
}

/** 检索 topK 段。 */
export function retrieveRelevantSegments(
  query: string,
  segments: string[],
  topK = 1,
): string[] {
  return segments
    .map((s) => ({ s, score: lexicalScore(query, s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.s);
}

/** 渲染检索叶（独立尾缀消息，形态对齐 mftr）。 */
export function renderRetrievalLeaf(segments: string[], maxTokens: number): string {
  if (segments.length === 0) return '';
  const header = '【检索记忆·相关段】';
  const lines = [header];
  let used = estimateTokens(header);
  for (const s of segments) {
    const cost = estimateTokens(s);
    if (used + cost > maxTokens) break;
    lines.push(s);
    used += cost;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface AssembleInput {
  entries: WorldInfoEntry[];
  /** 当前扫描文本（最新消息 + 最近上下文） */
  scanText: string;
  /** 会话历史（已渲染为字符串数组） */
  history: string[];
  /** 摘要块 */
  summary?: string;
  /** 作者注 */
  authorNote?: string;
  /** 用于概率判定的 rng（可注入以保证确定性） */
  rng?: () => number;
  cfg?: Partial<SsaConfig>;
  /** 事实槽状态（跨轮持久；不传则不启用事实槽） */
  factState?: FactSlotState;
}

export interface AssembleOutput {
  layers: ContextLayers;
  /** 更新后的事实槽状态（调用方需持久化） */
  factState?: FactSlotState;
  /** 统计（用于观测面板，不作门禁） */
  stats: {
    prefixEntries: number;
    suffixEntries: number;
    plainEntries: number;
    skeletonTokens: number;
    liveTokens: number;
    factTokens: number;
    leafTokens: number;
    activatedClusters: number;
  };
}

/**
 * 组装上下文（双轨）。
 *
 * Track A（原版）：plain 条目走 ST 语义（key 匹配 + probability + order）。
 * Track B（SSA）：骨架进前缀、活簇进尾缀、事实槽进尾缀、检索叶进尾缀。
 *
 * 两者可同时存在：社区世界书 = plain，标注过的 = 骨架/活簇。
 */
export function assembleContext(input: AssembleInput): AssembleOutput {
  const cfg: SsaConfig = { ...DEFAULT_SSA_CONFIG, ...input.cfg };
  const rng = input.rng ?? Math.random;
  // 边界归一化：entries 可能为 undefined（外部导入失败）、条目可能缺 key。
  // 实测未归一化时 undefined 直接抛 TypeError。
  const entries = normalizeEntries(input.entries);
  const scanText = input.scanText ?? '';

  const prefix: string[] = [];
  const suffix: string[] = [];

  // --- Track B：骨架 ---
  //
  // ⚠️ 预算帽必须用真实 token 基数。原写法 `(pct / 100) * Number.MAX_SAFE_INTEGER`
  // 恒等于无穷大、形同虚设（2026-09-12 实测：1648 条世界书单轮注入 28732 token，
  // 直接爆掉 8K/32K 上下文窗并触发上游 Range of input length 报错）。
  const trackBEnabled = cfg.enabled.skeletonLive || cfg.enabled.liveClusterWorldbook;
  let plan: SkeletonPlan = { skeleton: [], liveCandidates: [], clusters: new Map(), plain: [] };
  if (trackBEnabled) {
    plan = planSkeleton(entries);
    const skeletonBudget = (cfg.skeletonBudgetPct / 100) * cfg.maxContext;
    const kept = trimToBudget(plan.skeleton, skeletonBudget);
    for (const e of kept) prefix.push(e.content);
  }

  // --- Track A：原版语义处理 plain 条目 ---
  //
  // ⚠️ 回退依据必须是**开关状态**，不能是 `plan.plain.length`。
  // 反面教训（2026-09-12 缺陷复现）：全簇世界书（每条都带 clusterId）时
  // plan.plain 合法为空，用 length 判定会误触发回退 → 全部条目被 Track A
  // 再处理一遍，与 Track B 的骨架/活簇注入叠加 → 同一条内容注入两次（白烧 token）。
  const plainEntries = trackBEnabled ? plan.plain : entries;
  const plainActivated = sortByOrder(
    plainEntries.filter(
      (e) => matchesKeys(e, scanText) && passesProbability(e, rng),
    ),
  );
  for (const e of plainActivated) {
    // position 0 = 前置，其余（含 @D）暂统一进尾缀（MVP 简化，保持可测）
    if (e.position === 0) prefix.push(e.content);
    else suffix.push(e.content);
  }

  // --- Track B：活簇激活 ---
  let activatedClusters = 0;
  if (cfg.enabled.skeletonLive) {
    const live = activateClusters(plan, entries, scanText);
    const byCluster = new Set(live.map((e) => e.extensions?.clusterId).filter(Boolean));
    activatedClusters = byCluster.size;
    // 活簇要过预算帽：命中 1 个 key 会激活整簇，巨簇可一次带出大量内容。
    //
    // 额度 = 尾缀总预算 − 事实槽/检索叶的预留。
    // 反面教训：二者各有独立预算（factSlotMaxTokens / retrievalLeafTokens），
    // 若不从尾缀总额里扣除，实测 ×16 规模下各区都"没超自己的帽"，
    // 合计却是 8385 token > 8192 窗口 —— 照样爆窗。
    const reserved =
      (cfg.enabled.factSlot ? cfg.factSlotMaxTokens : 0) +
      (cfg.enabled.retrievalLeaf ? cfg.retrievalLeafTokens : 0);
    const liveBudget = Math.max(0, (cfg.liveBudgetPct / 100) * cfg.maxContext - reserved);
    for (const e of trimToBudget(live, liveBudget)) suffix.push(e.content);
  }

  // --- Track B：事实槽 ---
  let factTokens = 0;
  let nextFactState = input.factState;
  if (cfg.enabled.factSlot && input.factState) {
    const entities =
      input.factState.entities.length > 0
        ? input.factState.entities
        : collectFactEntities(entries);
    const st =
      input.factState.entities.length > 0
        ? input.factState
        : createFactSlotState(entities);
    nextFactState = updateFactSlot(st, scanText, cfg);
    if (nextFactState.block) {
      suffix.push(nextFactState.block);
      factTokens = estimateTokens(nextFactState.block);
    }
  }

  // --- Track B：检索叶 ---
  let leafTokens = 0;
  if (cfg.enabled.retrievalLeaf) {
    const segments = retrieveRelevantSegments(scanText, input.history, 1);
    const leaf = renderRetrievalLeaf(segments, cfg.retrievalLeafTokens);
    if (leaf) {
      suffix.push(leaf);
      leafTokens = estimateTokens(leaf);
    }
  }

  // --- 摘要 / 作者注（始终在尾缀） ---
  if (input.summary) suffix.push(input.summary);
  if (input.authorNote) suffix.push(input.authorNote);

  return {
    layers: { prefix, history: input.history, suffix },
    factState: nextFactState,
    stats: {
      prefixEntries: prefix.length,
      suffixEntries: suffix.length,
      plainEntries: plainEntries.length,
      skeletonTokens: prefix.reduce((n, s) => n + estimateTokens(s), 0),
      liveTokens: suffix.reduce((n, s) => n + estimateTokens(s), 0),
      factTokens,
      leafTokens,
      activatedClusters,
    },
  };
}

/** 渲染为最终消息数组（prefix → history → suffix 的顺序即缓存友好序）。 */
export function renderLayers(layers: ContextLayers): string[] {
  return [...layers.prefix, ...layers.history, ...layers.suffix];
}
