/**
 * 学习建议「确认闸」纯逻辑核。// [SSA-LEARN]
 *
 * ── 为什么把纯逻辑单拆出来 ────────────────────────────────────────────────
 * spec T3.1 的交付物是 `suggest-gate.svelte.ts`（响应式壳），但 Svelte 5 的
 * `$state` 必须经编译才能跑——**Node 里 import 不了**。若把判定逻辑写在壳里，
 * G3 的六项门禁就只能靠人眼看界面，等于没有门禁。
 * 故：**本文件零 DOM / 零 localStorage / 零 Svelte**，所有可判定逻辑都在这里；
 * 壳只做「响应式状态 + 存储 + 渲染数据」的接线。
 *
 * ── 与 spec 的对应 ────────────────────────────────────────────────────────
 * · C-06 / R-02：所有入口都要求**显式** `uid + action`；本模块**没有**任何
 *   「遍历 items 全部采纳」的批量函数——批量按钮将来也只能是循环调用 `decide()`，
 *   且必然经过 `shouldWarnMassAccept()`（反橡皮图章）。
 * · R-08：产物只暴露 `title / detail / source / confidence`；θ、minFreq、window
 *   等**内核数值不进本层**（它们在 `provision/index.ts` 的 `meta` 里，本层不读）。
 * · R-11：空态与降级态是**两个不同的 kind**（`empty` / `error`），都**不是**弹窗。
 * · C-09：`ledgerBytes()` 给出 UTF-8 实测字节数，供 UI 前置体积检查。
 */

import type { ProvisionSuggestions } from './provision/index.ts';

// ---------------------------------------------------------------------------
// 建议条目：5 类产物 → 用户可读列表项
// ---------------------------------------------------------------------------

export type SuggestionKind = 'cluster' | 'template' | 'scene' | 'coupling' | 'normalization';

/** 列表项预带的触发词个数上限（落盘时 `copy-core` 会再截一次，口径唯一）。 */
export const LEARNED_KEY_HINT = 6;

export const KIND_LABEL: Record<SuggestionKind, string> = {
  cluster: '候选簇',
  template: '模板行',
  scene: '场景触发',
  coupling: '词对耦合',
  normalization: '名称归并',
};

export interface SuggestionItem {
  /** 稳定 uid：`${kind}:${源 id}`。Phase 4 的 applied 台账以它为准。 */
  uid: string;
  kind: SuggestionKind;
  /** 用户可读标题 */
  title: string;
  /** 「应用」时写入的正文（Phase 4 落盘用；B' 阶段只进台账） */
  detail: string;
  /**
   * 落盘时用作世界书 `key` 的触发词（仅可落盘的两类携带）。
   * 观测性产物（场景/耦合/归并）没有触发词，故为 undefined。
   */
  keys?: string[];
  /** 归属候选簇（模板行才有；用于 UI 分组） */
  clusterId?: string;
  /** 四通道来源（透传，仅用于 UI 标注「来自哪条通道」） */
  source: string;
  confidence: number;
}

/** 5 类产物 → 列表项（顺序固定：簇 → 模板 → 场景 → 耦合 → 归并）。 */
export function buildSuggestionList(p: ProvisionSuggestions): SuggestionItem[] {
  const out: SuggestionItem[] = [];
  for (const c of p.candidateClusters) {
    out.push({
      uid: `cluster:${c.id}`,
      kind: 'cluster',
      title: c.title,
      detail: c.keywords.join('、'),
      // 触发词按词频降序取前几个（`candidateClusters.keywords` 已是文档频率降序）
      keys: c.keywords.slice(0, LEARNED_KEY_HINT),
      source: c.source,
      confidence: c.confidence,
    });
  }
  for (const t of p.templateDrafts) {
    out.push({
      uid: `template:${t.id}`,
      kind: 'template',
      title: t.template,
      detail: t.template,
      keys: t.keywords.slice(0, LEARNED_KEY_HINT),
      clusterId: t.clusterId,
      source: t.source,
      confidence: t.confidence,
    });
  }
  for (const s of p.sceneDetection) {
    out.push({
      uid: `scene:${s.id}`,
      kind: 'scene',
      title: s.title,
      detail: s.triggerWords.join('、'),
      source: s.source,
      confidence: s.confidence,
    });
  }
  for (const [i, e] of p.couplingReport.entries()) {
    out.push({
      uid: `coupling:${i}`,
      kind: 'coupling',
      title: `${e.pair[0]} ↔ ${e.pair[1]}`,
      detail: `${e.pair[0]} ↔ ${e.pair[1]}（共现 ${e.cooccurrence}）`,
      source: e.source,
      confidence: e.confidence,
    });
  }
  for (const [i, g] of p.normalizationMap.entries()) {
    out.push({
      uid: `normalization:${i}`,
      kind: 'normalization',
      title: g.canonical,
      detail: [g.canonical, ...g.variants].join(' / '),
      source: g.source,
      confidence: g.confidence,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 台账（采纳 / 拒绝 / 编辑 / 撤销）
// ---------------------------------------------------------------------------

/**
 * 决定的四种动作。
 *
 * `reverted` = **显式撤销**（Phase 4 / M3）：采纳并落盘之后，用户在世界书里
 * 不要它了。撤销后该 uid **回到「待确认」**（`isDecided` 为 false）——
 * 「撤销」的语义是回到未决，而不是记成另一种终态；否则用户无法再次采纳。
 */
export type DecisionAction = 'applied' | 'rejected' | 'edited' | 'reverted';

/** 落盘去向：哪本世界书、哪条条目（`extensions.learnedId`）。 */
export interface LearnedTarget {
  book: string;
  /** 条目稳定标识（写进 `extensions.learnedId`，撤销时按它摘除） */
  learnedId: string;
}

export interface Decision {
  uid: string;
  action: DecisionAction;
  /** 时间戳（由调用方注入，保证可确定性测试） */
  at: string | null;
  /** `edited` 时为编辑后的正文；其余为当时条目正文（留痕） */
  text: string;
  /** 仅 `applied` / `edited` 落盘时携带（记录写到了哪儿，供撤销与审计） */
  target?: LearnedTarget;
}

export interface Ledger {
  v: 1;
  decisions: Decision[];
}

export const LEDGER_KEY = 'tavern.learning.ledger';
export const LEDGER_VERSION = 1;

export function emptyLedger(): Ledger {
  return { v: LEDGER_VERSION, decisions: [] };
}

/**
 * 记录一次决定（**纯函数**：返回新台账，不改入参）。
 *
 * 同一 uid 重复决定以**最后一次**为准，但历史留痕（不删旧记录）——
 * 用户改主意是常态，且留痕可让体积评估反映真实最坏情况。
 *
 * `target` 只在**真的写进了世界书**之后才传（撤下时读它就知道去哪摘）；
 * 写入失败**不得**留下 applied 记录（R8：失败不静默，也不虚报成功）。
 */
export function decide(
  ledger: Ledger,
  uid: string,
  action: DecisionAction,
  text: string,
  at: string | null = null,
  target?: LearnedTarget,
): Ledger {
  if (!uid) throw new Error('decide(): uid 不可为空');
  const rec: Decision = target ? { uid, action, at, text, target } : { uid, action, at, text };
  return { v: LEDGER_VERSION, decisions: [...ledger.decisions, rec] };
}

/** 某 uid 的**最终**决定（无则 undefined）。 */
export function finalDecisionOf(ledger: Ledger, uid: string): Decision | undefined {
  for (let i = ledger.decisions.length - 1; i >= 0; i--) {
    if (ledger.decisions[i].uid === uid) return ledger.decisions[i];
  }
  return undefined;
}

/** 该 uid 是否已有**终态**决定：`reverted` 不算（撤销 = 回到未决）。 */
export function isDecided(ledger: Ledger, uid: string): boolean {
  const d = finalDecisionOf(ledger, uid);
  return d !== undefined && d.action !== 'reverted';
}

/** 尚未决定的条目（UI 列表只渲染这些 + 已决定的折叠区）。 */
export function pendingOf(items: SuggestionItem[], ledger: Ledger): SuggestionItem[] {
  return items.filter((it) => !isDecided(ledger, it.uid));
}

/** 去重后的「当前生效决定」计数（历史留痕不重复计数）。 */
export function tallyOf(ledger: Ledger): Record<DecisionAction, number> {
  const seen = new Set<string>();
  const out: Record<DecisionAction, number> = { applied: 0, rejected: 0, edited: 0, reverted: 0 };
  for (let i = ledger.decisions.length - 1; i >= 0; i--) {
    const d = ledger.decisions[i];
    if (seen.has(d.uid)) continue;
    seen.add(d.uid);
    out[d.action]++;
  }
  return out;
}

/** 某 uid 当前**值得撤销**的落盘记录（未撤销的 applied/edited 且有 target）。 */
export function liveTargetOf(ledger: Ledger, uid: string): Decision | undefined {
  const d = finalDecisionOf(ledger, uid);
  if (!d) return undefined;
  if (d.action !== 'applied' && d.action !== 'edited') return undefined;
  return d.target ? d : undefined;
}

/** 该 uid 的落盘去向（撤销时读它，不另存一份真相）。 */
export function targetOf(ledger: Ledger, uid: string): LearnedTarget | undefined {
  return liveTargetOf(ledger, uid)?.target;
}

/**
 * 某 uid 的**全部**落盘去向（去重，按 `learnedId`）。
 *
 * 为什么不止一个：`learnedId` 是内容派生的 ⇒ 用户「编辑后采纳」会**追加**一条
 * 新条目（旧条目按「只增不改」保留）。撤销必须把它们**都**摘掉，否则会留下孤儿。
 */
export function targetsOf(ledger: Ledger, uid: string): LearnedTarget[] {
  const seen = new Set<string>();
  const out: LearnedTarget[] = [];
  for (let i = ledger.decisions.length - 1; i >= 0; i--) {
    const d = ledger.decisions[i];
    if (d.uid !== uid || !d.target) continue;
    if (d.action !== 'applied' && d.action !== 'edited') continue;
    if (seen.has(d.target.learnedId)) continue;
    seen.add(d.target.learnedId);
    out.push(d.target);
  }
  return out;
}

/** 当前**仍在世界书里**的已应用条目（撤销过的已摘除，不在其中）。 */
export function appliedEntriesOf(
  ledger: Ledger,
): { uid: string; text: string; at: string | null; target: LearnedTarget }[] {
  const seen = new Set<string>();
  const out: { uid: string; text: string; at: string | null; target: LearnedTarget }[] = [];
  for (let i = ledger.decisions.length - 1; i >= 0; i--) {
    const d = ledger.decisions[i];
    if (seen.has(d.uid)) continue;
    seen.add(d.uid);
    if ((d.action === 'applied' || d.action === 'edited') && d.target) {
      out.push({ uid: d.uid, text: d.text, at: d.at, target: d.target });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 反橡皮图章（spec T3.3：30% 不告警 / 31% 告警）
// ---------------------------------------------------------------------------

export const MASS_ACCEPT_WARN_PCT = 30;

/**
 * 是否告警「批量采纳」。
 *
 * 口径（**必须显式写死，否则边界无法复现**）：
 *   · 分子 = **未经编辑的「采纳」**数（`applied`）—— `edited` 不算橡皮图章，
 *     因为作者动过正文；
 *   · 分母 = **已决定条目数**（applied + edited + rejected，按 uid 去重）。
 *     用「已决定」而非「全部建议」：用户只处理了 3 条就该只看这 3 条的比例，
 *     否则任何大列表在开头都会误报。
 *   · 判定 = `applied * 100 > decided * 30`（**整数比较**，避免浮点边界抖动）。
 *
 * 30% 恰好不告警、31% 告警 —— 与 spec T3.3 的字面边界一致。
 * 一次决定都没有时（decided === 0）**不告警**（空列表不是橡皮图章）。
 *
 * 注：若用户希望口径改为「占全部建议的比例」，改这一处即可（分母换成 items.length），
 * 但那样 30/31 的边界需要同步重定义并复测。
 */
export function shouldWarnMassAccept(ledger: Ledger): boolean {
  const t = tallyOf(ledger);
  // 撤销过的 uid 已回到未决，故既不在分子也不在分母（公式本身不变，边界结论也不变）
  const decided = t.applied + t.edited + t.rejected;
  if (decided === 0) return false;
  return t.applied * 100 > decided * MASS_ACCEPT_WARN_PCT;
}

/** 采纳比例（用于展示；**不用于判定**，避免浮点参与边界）。 */
export function acceptRatio(ledger: Ledger): number {
  const t = tallyOf(ledger);
  const decided = t.applied + t.edited + t.rejected;
  return decided === 0 ? 0 : t.applied / decided;
}

// ---------------------------------------------------------------------------
// 体积（C-09：落 localStorage 前必须实测上界）
// ---------------------------------------------------------------------------

/** 台账的 UTF-8 字节数（含 JSON 包装）。 */
export function ledgerBytes(ledger: Ledger): number {
  return new TextEncoder().encode(JSON.stringify(ledger)).length;
}

/** 建议列表的 UTF-8 字节数（判断「要不要落盘/要不要分页」用）。 */
export function itemsBytes(items: SuggestionItem[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).length;
}

// ---------------------------------------------------------------------------
// 闸状态机（R-11：空态 / 降级态 / 失败态 三者互不混淆，且都不是弹窗）
// ---------------------------------------------------------------------------

export type GateView =
  | { kind: 'idle' }
  | { kind: 'running' }
  /** 语料可读、管线跑完，但零建议 —— **不是**「后端不可用」 */
  | { kind: 'empty'; message: string }
  /** 读不到语料 / 管线抛错 —— **必须**与 empty 区分（R-11） */
  | { kind: 'error'; message: string }
  | { kind: 'ok'; items: SuggestionItem[]; pending: number; warnMassAccept: boolean };

/** 任何状态下都**不得**弹窗（R-11）；此常量把「不弹窗」写成可断言的事实。 */
export const GATE_USES_MODAL = false;

/** 一次学习运行的状态（壳与门禁共用同一形状，避免两处漂移）。 */
export type GateRun =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; items: SuggestionItem[] }
  | { status: 'failed'; message: string };

/**
 * 把「运行结果 + 台账」收束成一个 UI 状态。
 *
 * 这是 R-11 的**唯一判定点**：降级/失败绝不 fallback 到 `empty`。
 * `error` 必须带原始 message（R8：不静默失败）。
 */
export function gateView(run: GateRun, ledger: Ledger): GateView {
  if (run.status === 'idle') return { kind: 'idle' };
  if (run.status === 'running') return { kind: 'running' };
  if (run.status === 'failed') {
    return { kind: 'error', message: run.message || '学习失败（原因未知）' };
  }
  if (run.items.length === 0) {
    return {
      kind: 'empty',
      message: '这次没有学到可用的建议：语料太少或重复度太高。积累一些对话后再试。',
    };
  }
  return {
    kind: 'ok',
    items: run.items,
    pending: pendingOf(run.items, ledger).length,
    warnMassAccept: shouldWarnMassAccept(ledger),
  };
}

// ---------------------------------------------------------------------------
// 存储（依赖注入：Node 用假 storage，浏览器传 localStorage）
// ---------------------------------------------------------------------------

/** 只用到这三个方法，便于注入假实现做门禁。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LoadResult {
  ledger: Ledger;
  /** 非 null = 读到了东西但**不可用**（非法 JSON / 版本不符），已按空台账继续 */
  error: string | null;
}

/** 读台账：任何异常都**不抛**（学习功能坏了不能连累设置页），但要**报**。 */
export function loadLedger(storage: StorageLike | null): LoadResult {
  if (!storage) return { ledger: emptyLedger(), error: null };
  let raw: string | null = null;
  try {
    raw = storage.getItem(LEDGER_KEY);
  } catch (e) {
    return { ledger: emptyLedger(), error: `读取学习台账失败：${String(e)}` };
  }
  if (!raw) return { ledger: emptyLedger(), error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('不是对象');
    const obj = parsed as { v?: unknown; decisions?: unknown };
    if (obj.v !== LEDGER_VERSION) throw new Error(`版本不符（${String(obj.v)}）`);
    if (!Array.isArray(obj.decisions)) throw new Error('decisions 不是数组');
    const decisions: Decision[] = [];
    for (const d of obj.decisions as unknown[]) {
      const o = d as {
        uid?: unknown;
        action?: unknown;
        at?: unknown;
        text?: unknown;
        target?: unknown;
      };
      if (typeof o?.uid !== 'string' || typeof o?.text !== 'string') continue;
      const action = o.action;
      if (
        action !== 'applied' &&
        action !== 'rejected' &&
        action !== 'edited' &&
        action !== 'reverted'
      ) {
        continue;
      }
      const rec: Decision = {
        uid: o.uid,
        action,
        at: typeof o.at === 'string' ? o.at : null,
        text: o.text,
      };
      // target 是落盘去向：只有形状合法才收（半截数据宁可丢字段，不可伪造去向）
      const tg = o.target as { book?: unknown; learnedId?: unknown } | undefined;
      if (tg && typeof tg.book === 'string' && typeof tg.learnedId === 'string') {
        rec.target = { book: tg.book, learnedId: tg.learnedId };
      }
      decisions.push(rec);
    }
    return { ledger: { v: LEDGER_VERSION, decisions }, error: null };
  } catch (e) {
    return { ledger: emptyLedger(), error: `学习台账已损坏，已按空台账继续：${String(e)}` };
  }
}

/** 写台账：**失败必须显性**（R8），返回错误文本而不是吞掉。 */
export function saveLedger(storage: StorageLike | null, ledger: Ledger): string | null {
  if (!storage) return '本机存储不可用，学习台账未保存';
  try {
    storage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    return null;
  } catch (e) {
    return `学习台账写入失败（可能已满）：${String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// 语料来源（C-02 / R9：只读单角色会话键，绝不碰群聊键）
// ---------------------------------------------------------------------------

export const CORPUS_SESSION_KEY = 'tavern.sessions';

/**
 * 学习副本沙盒记录（Phase 4'：[SSA-LEARN] 沙盒化的落点）。
 *
 * 只存**关于副本的元信息**（哪本、从哪来、克隆时刻、克隆快照摘要），
 * 副本正文在后端世界书里，**不进 localStorage**。
 */
export const SANDBOX_KEY = 'tavern.learning.sandbox';

export interface SandboxRecord {
  v: 1;
  /** 副本名（学习产物**只允许**写它） */
  copyName: string;
  /** 源书名（原书；副本被删时安全切回的目标） */
  sourceName: string;
  /** 克隆时刻（ISO；由调用方注入，保证可确定性测试） */
  clonedAt: string | null;
  /** 克隆快照摘要（非学习条目的字节哈希）——增量视图的基线 */
  digest: import('./copy-core.ts').CopyDigest;
}

/** 读沙盒记录：任何异常都**不抛**（沙盒坏了不能连累设置页），但要**报**。 */
export function loadSandbox(storage: StorageLike | null): { sandbox: SandboxRecord | null; error: string | null } {
  if (!storage) return { sandbox: null, error: null };
  let raw: string | null = null;
  try {
    raw = storage.getItem(SANDBOX_KEY);
  } catch (e) {
    return { sandbox: null, error: `读取学习副本记录失败：${String(e)}` };
  }
  if (!raw) return { sandbox: null, error: null };
  try {
    const o = JSON.parse(raw) as Partial<SandboxRecord>;
    if (o?.v !== 1) throw new Error(`版本不符（${String(o?.v)}）`);
    if (typeof o.copyName !== 'string' || typeof o.sourceName !== 'string') throw new Error('缺少副本名/源书名');
    const d = o.digest;
    if (!d || typeof d !== 'object' || typeof (d as { byUid?: unknown }).byUid !== 'object') {
      throw new Error('缺少克隆快照摘要');
    }
    return {
      sandbox: {
        v: 1,
        copyName: o.copyName,
        sourceName: o.sourceName,
        clonedAt: typeof o.clonedAt === 'string' ? o.clonedAt : null,
        digest: d as SandboxRecord['digest'],
      },
      error: null,
    };
  } catch (e) {
    return { sandbox: null, error: `学习副本记录已损坏，已按「未启用沙盒」继续：${String(e)}` };
  }
}

/** 写沙盒记录：失败必须显性（返回错误文本而不是吞掉）。 */
export function saveSandbox(storage: StorageLike | null, rec: SandboxRecord | null): string | null {
  if (!storage) return '本机存储不可用，学习副本记录未保存';
  try {
    if (rec === null) storage.removeItem(SANDBOX_KEY);
    else storage.setItem(SANDBOX_KEY, JSON.stringify(rec));
    return null;
  } catch (e) {
    return `学习副本记录写入失败（可能已满）：${String(e)}`;
  }
}

/** 门禁用：学习路径**允许**读取的键（白名单）。群聊键不在其中。 */
export const LEARNING_READ_KEYS = [CORPUS_SESSION_KEY, SANDBOX_KEY] as const;

/**
 * 门禁用：学习路径**允许**写入的键（白名单）。
 * 注意：世界书正文（含副本）**不写 localStorage**，而是经 `worldbook.saveRawBook()`
 * 走后端 `/api/worldinfo/edit`（R-13 无文件导入；C-10 不新增端口/进程）。
 */
export const LEARNING_WRITE_KEYS = [LEDGER_KEY, SANDBOX_KEY] as const;

/**
 * 裁剪语料到窗口上限（T2.3 的主线程预算）。
 *
 * **返回裁剪与否**，调用方必须把「只学了最近 N 条」显性告知用户（R-11：
 * 不得静默降级）。取**最近**的 N 条：越近的对话越代表当前语境。
 */
export function applyWindow<T>(messages: T[], cap: number): { messages: T[]; truncated: boolean; total: number } {
  const total = messages.length;
  if (total <= cap) return { messages, truncated: false, total };
  return { messages: messages.slice(total - cap), truncated: true, total };
}
