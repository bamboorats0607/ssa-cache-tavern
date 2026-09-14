/**
 * 写作风格 store（本机持久化）。
 *
 * ── 为什么独立于 `advanced.svelte.ts` ────────────────────────────────────
 * 那边的 `sysprompt*` / `persona*` 字段目前**没有任何调用方**（生成链路不读它，
 * 见 `docs/写作风格引擎-接入设计.md` §四.3）。风格块若搭在那套字段上，会把
 * 「已存在的未接线功能」变成「接线范围失控」。故另立 store，键名独立。
 *
 * ── 前缀冻结（R1）──────────────────────────────────────────────────────
 * `guide` 是**字节冻结**的：同一 state 只会算出同一字符串，且结果按状态缓存
 * （`#cacheKey` 命中即复用）。用户改设置 → 缓存失效 → 下一轮前缀重建一次，
 * 设置页对此有显式提示。
 */

import { buildStyleGuide, normalizeSample, styleTokens } from '../lib/style/guide.ts';
import type { DepthKey, LensKey, StyleInput } from '../lib/style/types.ts';

/** 与其它 store 的命名口径一致（`tavern.advanced` / `tavern.ctx` / `tavern.model`）。 */
const KEY = 'tavern.writingStyle';

export interface WritingStyleState extends StyleInput {
  /**
   * 分条渲染：把一条回复按短消息切成多个气泡（纯展示层，不改落盘格式）。
   * 见 `lib/style/burst.ts` 的长度闸门——长段描写不会被切碎。
   */
  burst: boolean;
}

export const DEFAULT_WRITING_STYLE: WritingStyleState = {
  // 默认只开聊天体：对本 App 的用例（酒馆 = 聊天 + 描写）几乎纯收益，
  // 且不涉及题材尺度。尺度与视角是个人偏好，默认不注入。
  register: true,
  depth: 'none',
  lens: 'direct',
  sample: '',
  // 分条同样默认开：它是「像在手机上聊天」的一半；不满足长度闸门时不会生效
  burst: true,
};

function load(): WritingStyleState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_WRITING_STYLE };
    return { ...DEFAULT_WRITING_STYLE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WRITING_STYLE };
  }
}

class WritingStyleStore {
  state = $state<WritingStyleState>({ ...DEFAULT_WRITING_STYLE });

  /** 风格块缓存：同一 state 复用同一字符串，保证跨轮字节恒定。 */
  #cacheKey = '';
  #cache = '';

  constructor() {
    this.state = load();
  }

  /** 供生成链路使用的风格块。空串 = 不注入该块。 */
  get guide(): string {
    const key = `${this.state.register}|${this.state.depth}|${this.state.lens}|${this.state.sample}`;
    if (key !== this.#cacheKey) {
      this.#cache = buildStyleGuide(this.state);
      this.#cacheKey = key;
    }
    return this.#cache;
  }

  /** 当前风格块的 token 估算（设置页显示）。 */
  get tokens(): number {
    return styleTokens(this.state);
  }

  get<K extends keyof WritingStyleState>(key: K): WritingStyleState[K] {
    return this.state[key];
  }

  set<K extends keyof WritingStyleState>(key: K, value: WritingStyleState[K]) {
    // 样本在入口处就归一化：否则同一段文本在不同平台粘贴会写出不同字节，
    // 前缀稳定性会取决于用户在哪个设备上操作（见 guide.normalizeSample）。
    if (key === 'sample') {
      this.state.sample = normalizeSample(String(value));
    } else {
      this.state[key] = value;
    }
    this.persist();
  }

  reset() {
    this.state = { ...DEFAULT_WRITING_STYLE };
    this.persist();
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // 存不下（配额满/隐私模式）时不影响本次会话的生成：内存态仍然有效
    }
  }
}

export const writingStyle = new WritingStyleStore();
