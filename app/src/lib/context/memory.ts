/**
 * 记忆管理。
 *
 * ── 选型依据（回答「知识图谱 vs 摘要压缩」）──────────────────────────────
 *
 * 实测/代码事实：
 *  1) SillyBunny 现有 memory 扩展 = **纯摘要压缩**（`summary_sources` = main/extras/webllm），
 *     无图谱能力（grep `graph|entity|relation` 在 extensions/memory/ 无命中）。
 *  2) 项目的 SSA 红线 R3 明确要求：压缩必须**缓存对齐**（`ssaCompactChat` append-only），
 *     即摘要块只能追加、不能原地折叠 —— 否则前缀字节被破坏。
 *  3) 知识图谱（实体+关系）的**写入**往往伴随原地更新（实体属性变化），
 *     与 R1「前缀字节冻结」冲突；但图谱的**读取**可以是只读的。
 *
 * 结论：**两者不是二选一，而是分层**——
 *   · 摘要压缩 = 主干（时序叙事，「发生了什么」），append-only，符合 R3
 *   · 知识图谱 = 索引/检索层（角色关系、实体状态，「谁和谁什么关系」），
 *     产物注入尾缀区（接受 miss 代价，与 mftr 检索叶同层），不触碰前缀
 *
 * 这与研究资料一致：mftr 检索叶实测代价 -1~-2pp，换来相关性 63-67% 覆盖；
 * 图谱作为「结构化检索索引」比裸文本检索精度更高，代价同层。
 *
 * 实施顺序：先摘要（主干，必做）→ 图谱作为检索增强（可开关）。
 */

import { estimateTokens } from './assembler.ts';

// ---------------------------------------------------------------------------
// 摘要压缩（主干，append-only）
// ---------------------------------------------------------------------------

export interface SummaryState {
  /** 已产出的摘要段（append-only，永不修改已有元素） */
  segments: string[];
  /** 已覆盖到的消息索引（下次从此处继续） */
  coveredEnd: number;
  /** 迭代摘要的当前累积内容（用于喂给 LLM 作为 base） */
  rolling: string;
  lastLive: string;
}

export function createSummaryState(): SummaryState {
  return { segments: [], coveredEnd: 0, rolling: '', lastLive: '' };
}

/**
 * append-only 压缩（对齐 SSA 红线 R3 + `ssaCompactChat` 语义）。
 *
 * 关键：**不做原地折叠**。折叠会改写已注入的字节 → 前缀冻结被破坏。
 * 正确做法：把新产生的摘要段**追加**到末尾，旧段原样保留。
 */
export function compactChat(
  liveText: string,
  state: SummaryState,
  cfg: { threshold: number | null; keep: number },
): { mode: 'normal' | 'compacted'; content: string } {
  // 首轮：记录锚点，不压缩
  if (!state.lastLive) {
    state.lastLive = liveText;
    return { mode: 'normal', content: liveText };
  }

  const tokens = estimateTokens(liveText);
  if (cfg.threshold != null && tokens > cfg.threshold) {
    // 压缩轮：新摘要段追加在既有结构之后（append-only）
    const newSegment = `【摘要·第${state.segments.length + 1}段】${liveText}`;
    state.segments.push(newSegment);
    state.rolling = state.segments.join('\n');
    state.lastLive = liveText;

    return { mode: 'compacted', content: state.rolling };
  }

  state.lastLive = liveText;
  return { mode: 'normal', content: liveText };
}

/** 渲染摘要块供注入（尾缀区）。 */
export function renderSummary(state: SummaryState, maxTokens: number): string {
  if (state.segments.length === 0) return '';
  const header = '【前情摘要】';
  const lines: string[] = [header];
  let used = estimateTokens(header);
  // 从**最新**段往前取（近的记忆更相关）
  for (let i = state.segments.length - 1; i >= 0; i--) {
    const s = state.segments[i];
    const cost = estimateTokens(s);
    if (used + cost > maxTokens) break;
    lines.splice(1, 0, s);
    used += cost;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

// ---------------------------------------------------------------------------
// 知识图谱（检索增强层）
// ---------------------------------------------------------------------------

export interface Entity {
  id: string;
  name: string;
  /** 实体类型：character / location / item / concept */
  type: string;
  /** 属性（可追加观察，不原地修改语义） */
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  /** 关系类型：盟友/敌手/亲属/所属/持有… */
  kind: string;
  /** 首次建立轮次（用于时效判断） */
  since: number;
}

export interface KnowledgeGraph {
  entities: Map<string, Entity>;
  relations: Relation[];
}

export function createGraph(): KnowledgeGraph {
  return { entities: new Map(), relations: [] };
}

/**
 * 追加观察（append-only：同名实体的 observations 只增不改）。
 * 这与 MCP Knowledge Graph 的语义一致，也符合 R1 前缀冻结要求。
 */
export function addObservation(
  graph: KnowledgeGraph,
  name: string,
  type: string,
  observation: string,
): void {
  const id = normalizeId(name);
  const existing = graph.entities.get(id);
  if (existing) {
    if (!existing.observations.includes(observation)) {
      existing.observations.push(observation);
    }
  } else {
    graph.entities.set(id, { id, name, type, observations: [observation] });
  }
}

/** 建立关系（去重）。同时确保两端实体已登记，避免出现悬空关系。 */
export function addRelation(
  graph: KnowledgeGraph,
  from: string,
  to: string,
  kind: string,
  round: number,
): void {
  const f = normalizeId(from);
  const t = normalizeId(to);

  // 确保实体节点存在（否则图谱会出现只有关系、没有实体的悬空态）
  if (!graph.entities.has(f)) {
    graph.entities.set(f, { id: f, name: from, type: 'character', observations: [] });
  }
  if (!graph.entities.has(t)) {
    graph.entities.set(t, { id: t, name: to, type: 'character', observations: [] });
  }

  const dup = graph.relations.some(
    (r) => r.from === f && r.to === t && r.kind === kind,
  );
  if (dup) return;
  graph.relations.push({ from: f, to: t, kind, since: round });
}

/**
 * 从文本中抽取「人名 + 关系词 + 人名」三元组（纯代码，零 LLM）。
 *
 * 抽取质量有限（这是纯启发式的固有代价），因此：
 *  - 仅作为**检索索引**使用，不作为事实来源
 *  - 渲染时标注为 REFERENCE ONLY
 */
const RELATION_WORDS = [
  '是', '叫', '名叫', '来自', '属于', '加入', '离开',
  '的朋友', '的敌人', '的老师', '的学生', '的同伴',
  '喜欢', '讨厌', '认识', '照顾', '保护',
];

export function extractRelations(
  text: string,
  knownEntities: string[],
  round: number,
  graph: KnowledgeGraph,
): Relation[] {
  const created: Relation[] = [];
  const sentences = text.split(/[。！？\n]/).filter(Boolean);

  for (const sent of sentences) {
    // 找出本句出现的已知实体
    const present = knownEntities.filter((e) => e && sent.includes(e));
    if (present.length < 1) continue;

    const kind = RELATION_WORDS.find((w) => sent.includes(w));
    if (!kind) continue;

    if (present.length === 1) {
      // 单实体：记录为对该实体的一条观察（属性）
      const idx = sent.indexOf(present[0]);
      const snippet = sent.slice(Math.max(0, idx - 4), Math.min(sent.length, idx + 28));
      addObservation(graph, present[0], 'concept', snippet);
      continue;
    }

    // 多实体：建立两两关系（同一句内）
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        addRelation(graph, present[i], present[j], kind, round);
        created.push({ from: normalizeId(present[i]), to: normalizeId(present[j]), kind, since: round });
      }
    }
  }
  return created;
}

/** 查询与给定实体直接相关的关系（1 跳）。 */
export function queryRelations(graph: KnowledgeGraph, name: string): Relation[] {
  const id = normalizeId(name);
  return graph.relations.filter((r) => r.from === id || r.to === id);
}

/**
 * 渲染图谱片段供注入（尾缀区，与检索叶同层）。
 * 形态：`A --kind--> B`，并附实体观察。
 */
export function renderGraphSlice(
  graph: KnowledgeGraph,
  keywords: string[],
  maxTokens: number,
): string {
  const hitEntities = [...graph.entities.values()].filter((e) =>
    keywords.some((k) => k && (e.name.includes(k) || k.includes(e.name))),
  );
  if (hitEntities.length === 0) return '';

  const header = '【关系索引·REFERENCE ONLY】';
  const lines: string[] = [header];
  let used = estimateTokens(header);

  for (const e of hitEntities) {
    const rels = queryRelations(graph, e.name);
    const nameOf = (id: string) => graph.entities.get(id)?.name ?? id;
    for (const r of rels) {
      const line = `${nameOf(r.from)} —${r.kind}→ ${nameOf(r.to)}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) return lines.length > 1 ? lines.join('\n') : '';
      if (!lines.includes(line)) {
        lines.push(line);
        used += cost;
      }
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function normalizeId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// 统一记忆管理器
// ---------------------------------------------------------------------------

export interface MemoryConfig {
  /** 摘要触发阈值（token），null = 不自动触发 */
  summaryThreshold: number | null;
  summaryKeep: number;
  summaryMaxTokens: number;
  /** 图谱开关（默认关，逐项启用便于 A/B） */
  graphEnabled: boolean;
  graphMaxTokens: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  summaryThreshold: null,
  summaryKeep: 6,
  summaryMaxTokens: 600,
  graphEnabled: false,
  graphMaxTokens: 200,
};

export class MemoryManager {
  summary = createSummaryState();
  graph = createGraph();
  private round = 0;
  private cfg: MemoryConfig;

  constructor(cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG) {
    this.cfg = cfg;
  }

  /** 每轮喂入最新文本，返回本轮应注入尾缀的记忆块。 */
  ingest(text: string, knownEntities: string[]): string {
    this.round++;

    // 主干：摘要（append-only）
    const { content } = compactChat(text, this.summary, {
      threshold: this.cfg.summaryThreshold,
      keep: this.cfg.summaryKeep,
    });
    void content;

    // 增强：图谱索引
    if (this.cfg.graphEnabled) {
      extractRelations(text, knownEntities, this.round, this.graph);
    }

    const blocks: string[] = [];
    const s = renderSummary(this.summary, this.cfg.summaryMaxTokens);
    if (s) blocks.push(s);
    if (this.cfg.graphEnabled) {
      const g = renderGraphSlice(this.graph, knownEntities, this.cfg.graphMaxTokens);
      if (g) blocks.push(g);
    }
    return blocks.join('\n\n');
  }

  /** 统计（观测用）。 */
  stats() {
    return {
      summarySegments: this.summary.segments.length,
      entities: this.graph.entities.size,
      relations: this.graph.relations.length,
      round: this.round,
    };
  }

  reset() {
    this.summary = createSummaryState();
    this.graph = createGraph();
    this.round = 0;
  }
}
