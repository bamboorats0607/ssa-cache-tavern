/**
 * 上下文与记忆配置 store。
 *
 * 设计：与后端契约同构（字段名对齐 assembler.ts / memory.ts），
 * 改动即时生效并持久化到 localStorage。
 */

import { DEFAULT_SSA_CONFIG, type SsaConfig } from '../lib/context/assembler';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../lib/context/memory';
import { logger } from '../lib/logger';

const CTX_KEY = 'tavern.ctx';
const MEM_KEY = 'tavern.memory';

function load<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 静默 */
  }
}

class CtxStore {
  /**
   * 上下文策略（双轨保留）：
   *  - 'auto'  原版逐条注入（策略 A，社区世界书默认行为）
   *  - 'sl'    骨架-活簇双层（策略 M）
   */
  strategy = $state<'auto' | 'sl'>(DEFAULT_SSA_CONFIG.enabled.skeletonLive ? 'sl' : 'auto');

  skeletonLive = $state(DEFAULT_SSA_CONFIG.enabled.skeletonLive);
  liveClusterWorldbook = $state(DEFAULT_SSA_CONFIG.enabled.liveClusterWorldbook);
  factSlot = $state(DEFAULT_SSA_CONFIG.enabled.factSlot);
  retrievalLeaf = $state(DEFAULT_SSA_CONFIG.enabled.retrievalLeaf);

  // —— 压缩（MC 策略，实测参数）——
  /** 是否启用压缩 */
  compactEnabled = $state(false);
  /** 触发阈值（token）；0 = 自动取 maxContext * 0.5（实测默认） */
  compactThreshold = $state(0);
  /** 压缩时保留最近条数（实测默认 6） */
  compactKeep = $state(DEFAULT_SSA_CONFIG.compactKeep);
  /**
   * 压缩因数（压缩后 / 压缩前），对齐 LLMLingua `rate` 语义。
   * 0.75 = 实测基准（每行保留 36 字）；越大保留越多原文。
   */
  compactRatio = $state(DEFAULT_SSA_CONFIG.compactRatio);

  // 数值参数
  skeletonWindowRounds = $state(DEFAULT_SSA_CONFIG.skeletonWindowRounds);
  skeletonBudgetPct = $state(DEFAULT_SSA_CONFIG.skeletonBudgetPct);
  liveBudgetPct = $state(DEFAULT_SSA_CONFIG.liveBudgetPct);
  factSlotMaxTokens = $state(DEFAULT_SSA_CONFIG.factSlotMaxTokens);
  retrievalLeafTokens = $state(DEFAULT_SSA_CONFIG.retrievalLeafTokens);

  constructor() {
    const raw = load<Record<string, unknown>>(CTX_KEY, {});
    if (raw.strategy === 'auto' || raw.strategy === 'sl') this.strategy = raw.strategy;
    if (typeof raw.skeletonLive === 'boolean') this.skeletonLive = raw.skeletonLive;
    if (typeof raw.liveClusterWorldbook === 'boolean') this.liveClusterWorldbook = raw.liveClusterWorldbook;
    if (typeof raw.factSlot === 'boolean') this.factSlot = raw.factSlot;
    if (typeof raw.retrievalLeaf === 'boolean') this.retrievalLeaf = raw.retrievalLeaf;
    if (typeof raw.compactEnabled === 'boolean') this.compactEnabled = raw.compactEnabled;
    if (typeof raw.compactThreshold === 'number') this.compactThreshold = raw.compactThreshold;
    if (typeof raw.compactKeep === 'number') this.compactKeep = raw.compactKeep;
    if (typeof raw.compactRatio === 'number') this.compactRatio = raw.compactRatio;
    if (typeof raw.skeletonWindowRounds === 'number') this.skeletonWindowRounds = raw.skeletonWindowRounds;
    if (typeof raw.skeletonBudgetPct === 'number') this.skeletonBudgetPct = raw.skeletonBudgetPct;
    if (typeof raw.liveBudgetPct === 'number') this.liveBudgetPct = raw.liveBudgetPct;
    if (typeof raw.factSlotMaxTokens === 'number') this.factSlotMaxTokens = raw.factSlotMaxTokens;
    if (typeof raw.retrievalLeafTokens === 'number') this.retrievalLeafTokens = raw.retrievalLeafTokens;
  }

  /**
   * 切换某个布尔开关。UI 改动统一走此方法，持久化 + 记日志。
   */
  set(
    key:
      | 'skeletonLive'
      | 'liveClusterWorldbook'
      | 'factSlot'
      | 'retrievalLeaf'
      | 'compactEnabled',
    value: boolean,
  ) {
    this[key] = value;
    this.persist();
    logger.info('ctx', `上下文开关 ${key} = ${value}`);
  }

  /** 切换策略：自动同步相关开关（A 策略关双层，M 策略开双层）。 */
  setStrategy(s: 'auto' | 'sl') {
    this.strategy = s;
    this.skeletonLive = s === 'sl';
    this.persist();
    logger.info('ctx', `上下文策略 = ${s === 'sl' ? '骨架-活簇(M)' : '原版逐条(A)'}`);
  }

  /** 数值项统一设置。 */
  setNumber(
    key:
      | 'compactThreshold'
      | 'compactKeep'
      | 'compactRatio'
      | 'skeletonWindowRounds'
      | 'skeletonBudgetPct'
      | 'liveBudgetPct'
      | 'factSlotMaxTokens'
      | 'retrievalLeafTokens',
    value: number,
  ) {
    this[key] = value;
    this.persist();
  }

  /** 导出为 assembler 可用的配置。 */
  toSsaConfig(): SsaConfig {
    return {
      ...DEFAULT_SSA_CONFIG,
      skeletonWindowRounds: this.skeletonWindowRounds,
      skeletonBudgetPct: this.skeletonBudgetPct,
      liveBudgetPct: this.liveBudgetPct,
      factSlotMaxTokens: this.factSlotMaxTokens,
      retrievalLeafTokens: this.retrievalLeafTokens,
      compactKeep: this.compactKeep,
      compactRatio: this.compactRatio,
      enabled: {
        skeletonLive: this.skeletonLive,
        liveClusterWorldbook: this.liveClusterWorldbook,
        factSlot: this.factSlot,
        retrievalLeaf: this.retrievalLeaf,
      },
    };
  }

  persist() {
    persist(CTX_KEY, {
      strategy: this.strategy,
      skeletonLive: this.skeletonLive,
      liveClusterWorldbook: this.liveClusterWorldbook,
      factSlot: this.factSlot,
      retrievalLeaf: this.retrievalLeaf,
      compactEnabled: this.compactEnabled,
      compactThreshold: this.compactThreshold,
      compactKeep: this.compactKeep,
      compactRatio: this.compactRatio,
      skeletonWindowRounds: this.skeletonWindowRounds,
      skeletonBudgetPct: this.skeletonBudgetPct,
      liveBudgetPct: this.liveBudgetPct,
      factSlotMaxTokens: this.factSlotMaxTokens,
      retrievalLeafTokens: this.retrievalLeafTokens,
    });
  }
}

class MemStore {
  summaryThreshold = $state<number | null>(DEFAULT_MEMORY_CONFIG.summaryThreshold);
  summaryMaxTokens = $state(DEFAULT_MEMORY_CONFIG.summaryMaxTokens);
  graphEnabled = $state(DEFAULT_MEMORY_CONFIG.graphEnabled);
  graphMaxTokens = $state(DEFAULT_MEMORY_CONFIG.graphMaxTokens);

  constructor() {
    const raw = load<Record<string, unknown>>(MEM_KEY, {});
    if (raw.summaryThreshold === null || typeof raw.summaryThreshold === 'number') {
      this.summaryThreshold = raw.summaryThreshold as number | null;
    }
    if (typeof raw.summaryMaxTokens === 'number') this.summaryMaxTokens = raw.summaryMaxTokens;
    if (typeof raw.graphEnabled === 'boolean') this.graphEnabled = raw.graphEnabled;
    if (typeof raw.graphMaxTokens === 'number') this.graphMaxTokens = raw.graphMaxTokens;
  }

  /** 切换自动摘要（null = 关闭）。 */
  setSummaryEnabled(on: boolean) {
    this.summaryThreshold = on ? 4000 : null;
    this.persist();
    logger.info('memory', `自动摘要 = ${on}`);
  }

  /** 切换关系索引。 */
  setGraphEnabled(on: boolean) {
    this.graphEnabled = on;
    this.persist();
    logger.info('memory', `关系索引 = ${on}`);
  }

  /** 数值项统一设置。 */
  setNumber(
    key: 'summaryThreshold' | 'summaryMaxTokens' | 'graphMaxTokens',
    value: number,
  ) {
    this[key] = value;
    this.persist();
  }

  toConfig(): MemoryConfig {
    return {
      summaryThreshold: this.summaryThreshold,
      summaryKeep: DEFAULT_MEMORY_CONFIG.summaryKeep,
      summaryMaxTokens: this.summaryMaxTokens,
      graphEnabled: this.graphEnabled,
      graphMaxTokens: this.graphMaxTokens,
    };
  }

  persist() {
    persist(MEM_KEY, this.toConfig());
  }
}

export const ctxConfig = new CtxStore();
export const memoryConfig = new MemStore();
