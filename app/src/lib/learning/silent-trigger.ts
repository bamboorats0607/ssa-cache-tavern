/**
 * 静默学习的触发内核（**纯函数**，spec §10 / P7 / LG-13 / LG-16 / LG-17）。// [SSA-LEARN]
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 * 触发策略是**可判定**的（去抖窗口、节流基线、工作量预算、跳过原因），与响应式壳、
 * 计时器、Worker 无关。把它抽成纯函数，门禁才能在 Node 里直跑，
 * 「什么时候会写、什么时候不写」才有机器可读的答案。
 *
 * ── 设计要点（逐条对齐裁定）────────────────────────────────────────────────
 * · **事件驱动，不是定时器**：触发源是「一轮对话完成」这个事件；壳负责去抖，
 *   本模块只回答「现在允许跑吗」。没有任何 `setInterval`。
 * · **节流基线持久化**：上次静默运行时刻 + 每个会话已学到的轮数一起落盘，
 *   刷新页面不会把节流丢掉（否则刷新就能绕过节流）。
 * · **按角色限定**：调用方必须用**触发会话的角色**取语料（`scopeToCharacter(..., 'none')`），
 *   本模块只做准入判断，不碰语料。
 * · **工作量预算（主线程纪律）**：静默运行必须**有界**。主线程同步跑的实测口径是
 *   ~0.13 ms/条消息（442 条 → 59 ms），所以把「单次静默最多处理多少轮」写死成预算：
 *   超预算 → **不跑**，改为显性提示「积压较多，请手动学习」。宁可少学，不卡输入。
 * · **跳过一律显性**：任何一次不跑都带 `reason`（用户可见），不出现「默默什么都没发生」。
 */

/** 静默触发状态（落盘；`tavern.learning.trigger`）。 */
export interface SilentTriggerState {
  v: 1;
  /** 自动学习总开关（**默认关**；开启需用户在面板显式打开，且副本已就绪） */
  auto: boolean;
  /** 上次静默运行时刻（ISO；null = 从未） */
  lastRunAt: string | null;
  /** 每个会话「上次静默运行时的轮数」——用于算新增轮数（会话数有上限，不会无限长） */
  lastRunTurns: Record<string, number>;
  /** 上次**没跑**的原因（显性告知；null = 上次跑了或还没触发过） */
  lastSkip: { at: string; kind: SkipKind; reason: string } | null;
  /** 累计静默写入条数（可观测） */
  writtenTotal: number;
  /** 累计静默运行次数（可观测） */
  runs: number;
}

export type SkipKind =
  | 'disabled'
  | 'noSandbox'
  | 'copyNotActive'
  | 'writing'
  | 'throttled'
  | 'tooLittle'
  | 'backlog'
  | 'quotaPaused'
  | 'noCorpus';

/** 少于这么多「新增轮」就不值得跑：一轮对话刚结束时通常只有 1 轮新增。 */
export const SILENT_MIN_TURNS = 2;
/** 同一会话两次静默运行的最短间隔（去抖之外的**节流**；防高频写盘）。 */
export const SILENT_MIN_INTERVAL_MS = 5 * 60_000;
/** 单次静默最多处理的新增轮数（≈2× 消息数 × 0.13 ms/条 → 120 轮 ≈ 260 条 ≈ 34 ms）。 */
export const SILENT_TURN_BUDGET = 120;
/** 去抖窗口：一轮完成后等这么久再跑（用户连续发消息时不反复触发）。 */
export const SILENT_DEBOUNCE_MS = 4000;

export function defaultTriggerState(): SilentTriggerState {
  return {
    v: 1,
    auto: false,
    lastRunAt: null,
    lastRunTurns: {},
    lastSkip: null,
    writtenTotal: 0,
    runs: 0,
  };
}

/** 会话里「还没被静默学习看过」的轮数（无记录 = 整个会话都是新的）。 */
export function pendingTurnsOf(state: SilentTriggerState, sessionId: string, totalTurns: number): number {
  const seen = state.lastRunTurns[sessionId];
  const base = typeof seen === 'number' && Number.isFinite(seen) ? seen : 0;
  return Math.max(0, totalTurns - base);
}

export interface RunContext {
  /** 现在（注入，保证可确定性测试） */
  now: Date;
  /** 触发会话的新增轮数 */
  pendingTurns: number;
  /** 该会话是否有可用语料（角色可限定 + 至少一条非空文本） */
  hasCorpus: boolean;
  /** 沙盒是否已就绪（副本存在） */
  hasSandbox: boolean;
  /** 副本是否正是启用书（不是则写进去也不会被注入） */
  copyActive: boolean;
  /** 配额是否已触顶（触顶时**不跑**，由面板显性暂停） */
  quotaPaused: boolean;
  /** 是否有写入正在进行（避免并发写盘） */
  writing: boolean;
}

export interface RunDecision {
  run: boolean;
  /** 不跑的原因分类（run === true 时为 null） */
  kind: SkipKind | null;
  /** 给用户看的一句话（run === true 时为 null） */
  reason: string | null;
}

const skip = (kind: SkipKind, reason: string): RunDecision => ({ run: false, kind, reason });

/**
 * 准入判定（**唯一**判据，壳与门禁共用）。
 *
 * 顺序即优先级：先看前提（开关/沙盒/副本/并发/配额），再看节流与工作量。
 * 任一不满足即**不跑**并说明原因（fail-closed）。
 */
export function decideRun(state: SilentTriggerState, ctx: RunContext): RunDecision {
  if (!state.auto) return skip('disabled', '自动学习未开启');
  if (!ctx.hasSandbox) {
    return skip('noSandbox', '还没有学习副本：自动学习不会写任何地方（先创建并启用副本）');
  }
  if (!ctx.copyActive) {
    return skip('copyNotActive', '副本当前不是启用的世界书：自动学习已暂停（避免写进不会被注入的书）');
  }
  if (ctx.writing) return skip('writing', '上一次写入还没结束，本轮跳过');
  if (ctx.quotaPaused) {
    return skip('quotaPaused', '学习配额已满：自动学习已暂停（不会静默丢弃，处理后可继续）');
  }
  if (ctx.pendingTurns < SILENT_MIN_TURNS) {
    return skip('tooLittle', `新增对话还不到 ${SILENT_MIN_TURNS} 轮，先攒一攒`);
  }
  if (!ctx.hasCorpus) return skip('noCorpus', '这段会话没有可用于学习的文本');

  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  if (Number.isFinite(last)) {
    const elapsed = ctx.now.getTime() - last;
    if (elapsed < SILENT_MIN_INTERVAL_MS) {
      const left = Math.ceil((SILENT_MIN_INTERVAL_MS - elapsed) / 60_000);
      return skip('throttled', `距上次自动学习不到 ${SILENT_MIN_INTERVAL_MS / 60_000} 分钟（约 ${left} 分钟后可再跑）`);
    }
  }

  if (ctx.pendingTurns > SILENT_TURN_BUDGET) {
    return skip(
      'backlog',
      `积压了 ${ctx.pendingTurns} 轮（单次上限 ${SILENT_TURN_BUDGET} 轮）——` +
        '不自动跑，请点「开始学习」手动学一次（避免占用主线程影响输入）',
    );
  }

  return { run: true, kind: null, reason: null };
}

/** 运行成功后的状态推进（**只加不改**：写回时刻、各会话轮数基线、计数）。 */
export function advanceAfterRun(
  state: SilentTriggerState,
  opts: { now: Date; sessionId: string; totalTurns: number; written: number },
): SilentTriggerState {
  return {
    ...state,
    lastRunAt: opts.now.toISOString(),
    lastRunTurns: { ...state.lastRunTurns, [opts.sessionId]: opts.totalTurns },
    lastSkip: null,
    writtenTotal: state.writtenTotal + Math.max(0, opts.written),
    runs: state.runs + 1,
  };
}

/** 记录一次「没跑」（用户可见；下一次成功运行会清掉）。 */
export function advanceAfterSkip(state: SilentTriggerState, opts: { now: Date; decision: RunDecision }): SilentTriggerState {
  if (opts.decision.run || opts.decision.kind === null) return state;
  return {
    ...state,
    lastSkip: { at: opts.now.toISOString(), kind: opts.decision.kind, reason: opts.decision.reason ?? '' },
  };
}

/** 开关（**只有用户能改**；`auto` 默认关）。 */
export function withAuto(state: SilentTriggerState, auto: boolean): SilentTriggerState {
  return { ...state, auto };
}

// ---------------------------------------------------------------------------
// 落盘（与 gate-core 的 storage 口径一致）
// ---------------------------------------------------------------------------

export interface TriggerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TRIGGER_KEY = 'tavern.learning.trigger';

/** 读触发状态：异常**不抛**（触发状态坏了不能连累面板），但要报。 */
export function loadTriggerState(storage: TriggerStorage | null): {
  state: SilentTriggerState;
  error: string | null;
} {
  if (!storage) return { state: defaultTriggerState(), error: null };
  let raw: string | null = null;
  try {
    raw = storage.getItem(TRIGGER_KEY);
  } catch (e) {
    return { state: defaultTriggerState(), error: `读取自动学习记录失败：${String(e)}` };
  }
  if (!raw) return { state: defaultTriggerState(), error: null };
  try {
    const o = JSON.parse(raw) as Partial<SilentTriggerState>;
    if (o?.v !== 1) throw new Error(`版本不符（${String(o?.v)}）`);
    const turns = o.lastRunTurns && typeof o.lastRunTurns === 'object' ? o.lastRunTurns : {};
    const cleanTurns: Record<string, number> = {};
    for (const [k, v] of Object.entries(turns)) {
      if (typeof v === 'number' && Number.isFinite(v)) cleanTurns[k] = v;
    }
    return {
      state: {
        v: 1,
        // 保守：读不出 `auto === true` 就当**关**（自动化行为不得因数据损坏而被打开）
        auto: o.auto === true,
        lastRunAt: typeof o.lastRunAt === 'string' ? o.lastRunAt : null,
        lastRunTurns: cleanTurns,
        lastSkip:
          o.lastSkip && typeof o.lastSkip === 'object' && typeof o.lastSkip.reason === 'string'
            ? {
                at: typeof o.lastSkip.at === 'string' ? o.lastSkip.at : '',
                kind: (o.lastSkip.kind as SkipKind) ?? 'disabled',
                reason: o.lastSkip.reason,
              }
            : null,
        writtenTotal: typeof o.writtenTotal === 'number' && Number.isFinite(o.writtenTotal) ? o.writtenTotal : 0,
        runs: typeof o.runs === 'number' && Number.isFinite(o.runs) ? o.runs : 0,
      },
      error: null,
    };
  } catch (e) {
    return {
      state: defaultTriggerState(),
      error: `自动学习记录已损坏，已按「未开启」继续：${String(e)}`,
    };
  }
}

/** 写触发状态：失败必须显性（返回错误文本而不是吞掉）。 */
export function saveTriggerState(storage: TriggerStorage | null, state: SilentTriggerState): string | null {
  if (!storage) return '本机存储不可用，自动学习记录未保存';
  try {
    storage.setItem(TRIGGER_KEY, JSON.stringify(state));
    return null;
  } catch (e) {
    return `自动学习记录写入失败（可能已满）：${String(e)}`;
  }
}

/** 面板脚注文案（可观测项；与 UI 同口径）。 */
export function silentLineOf(state: SilentTriggerState): string {
  if (!state.auto) return '自动学习：关';
  if (state.runs === 0) return '自动学习：开（还没跑过）';
  const at = state.lastRunAt ? state.lastRunAt.replace('T', ' ').slice(0, 16) : '（未知时刻）';
  return `自动学习：开 · 上次 ${at} · 累计写入 ${state.writtenTotal} 条`;
}
