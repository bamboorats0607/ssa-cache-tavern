/**
 * 高级设置 store —— 对齐 SillyBunny 的真实字段。
 *
 * 字段来源（逐字段取证，非臆测）：
 *  · 上下文/指令：`power-user.js:416-497`（power_user.context / instruct / sysprompt）
 *  · 世界书：`world-info.js:108-125`（world_info_*）
 *  · 聊天：`power-user.js:307-414`（chat_truncation / streaming_fps / send_on_enter …）
 *  · 记忆扩展：`extensions/memory/index.js:120-153`
 *
 * 默认值一律取源码默认值，便于「用户心智 = 原版酒馆」。
 */

import { logger } from '../lib/logger';

const KEY = 'tavern.advanced';

/** 注入位置（对齐 extension_prompt_types，script.js:800-805）。 */
export const INJECT_POSITIONS = [
  { value: 0, label: '随主提示（前缀）' },
  { value: 1, label: '聊天内指定深度' },
] as const;

/** 注入角色（对齐 extension_prompt_roles，script.js:810-814）。 */
export const INJECT_ROLES = [
  { value: 0, label: 'System' },
  { value: 1, label: 'User' },
  { value: 2, label: 'Assistant' },
] as const;

/** 世界书插入策略（world-info.js:70-74）。 */
export const WI_STRATEGIES = [
  { value: 0, label: '均匀分布' },
  { value: 1, label: '角色条目优先' },
  { value: 2, label: '全局条目优先' },
] as const;

/** 回车发送模式（power-user.js:282-286）。 */
export const SEND_ON_ENTER = [
  { value: 0, label: '自动（桌面回车 / 移动换行）' },
  { value: -1, label: '从不（只能点发送）' },
  { value: 1, label: '总是回车发送' },
] as const;

export interface AdvancedState {
  // —— 上下文模板（power_user.context）——
  storyString: string;
  exampleSeparator: string;
  chatStart: string;
  storyStringPosition: number;
  storyStringRole: number;
  storyStringDepth: number;
  tokenPadding: number;
  collapseNewlines: boolean;
  trimSentences: boolean;
  trimSpaces: boolean;

  // —— 指令模式（power_user.instruct）——
  instructEnabled: boolean;
  inputSequence: string;
  outputSequence: string;
  systemSequence: string;
  stopSequence: string;
  wrapSequences: boolean;
  sequencesAsStopStrings: boolean;

  // —— 系统提示（power_user.sysprompt）——
  syspromptEnabled: boolean;
  syspromptContent: string;
  syspromptPostHistory: string;

  // —— 用户身份（power_user.persona_description_*）——
  personaDescription: string;
  personaPosition: number;
  personaRole: number;
  personaDepth: number;

  // —— 世界书（world_info_*）——
  wiDepth: number;
  wiBudget: number;
  wiBudgetCap: number;
  wiMinActivations: number;
  wiMaxRecursionSteps: number;
  wiRecursive: boolean;
  wiCaseSensitive: boolean;
  wiMatchWholeWords: boolean;
  wiIncludeNames: boolean;
  wiUseGroupScoring: boolean;
  wiCharacterStrategy: number;

  // —— 记忆扩展（extensions/memory）——
  memoryFrozen: boolean;
  memoryFrozenSource: string;
  memoryPromptTemplate: string;
  memoryPromptWords: number;
  memoryPromptInterval: number;
  memoryPromptForceWords: number;
  memorySkipWIAN: boolean;
  memoryScan: boolean;

  // —— 聊天（power_user）——
  chatTruncation: number;
  streamingFps: number;
  autoScroll: boolean;
  autoFixMarkdown: boolean;
  sendOnEnter: number;
  showTokenCount: boolean;
  allowNameDisplay: boolean;

  // —— 界面 ——
  fontScale: number;
}

export const DEFAULT_ADVANCED: AdvancedState = {
  storyString: '',          // 空 = 使用内置默认故事串接
  exampleSeparator: '***',
  chatStart: '***',
  storyStringPosition: 0,
  storyStringRole: 0,
  storyStringDepth: 1,
  tokenPadding: 64,
  collapseNewlines: false,
  trimSentences: false,
  trimSpaces: true,

  instructEnabled: false,
  inputSequence: '### Instruction:',
  outputSequence: '### Response:',
  systemSequence: '',
  stopSequence: '',
  wrapSequences: true,
  sequencesAsStopStrings: true,

  syspromptEnabled: true,
  syspromptContent: '',
  syspromptPostHistory: '',

  personaDescription: '',
  personaPosition: 0,
  personaRole: 0,
  personaDepth: 2,

  wiDepth: 2,
  wiBudget: 25,
  wiBudgetCap: 0,
  wiMinActivations: 0,
  wiMaxRecursionSteps: 0,
  wiRecursive: false,
  wiCaseSensitive: false,
  wiMatchWholeWords: false,
  wiIncludeNames: true,
  wiUseGroupScoring: false,
  wiCharacterStrategy: 1,

  memoryFrozen: false,
  memoryFrozenSource: 'main',
  memoryPromptTemplate: '[Summary: {{summary}}]',
  memoryPromptWords: 200,
  memoryPromptInterval: 10,
  memoryPromptForceWords: 0,
  memorySkipWIAN: false,
  memoryScan: false,

  chatTruncation: 100,
  streamingFps: 30,
  autoScroll: true,
  autoFixMarkdown: true,
  sendOnEnter: 0,
  showTokenCount: false,
  allowNameDisplay: false,

  fontScale: 1.0,
};

function load(): AdvancedState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_ADVANCED };
    return { ...DEFAULT_ADVANCED, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_ADVANCED };
  }
}

class AdvancedStore {
  state = $state<AdvancedState>({ ...DEFAULT_ADVANCED });

  constructor() {
    this.state = load();
    this.applyFontScale();
  }

  get<K extends keyof AdvancedState>(key: K): AdvancedState[K] {
    return this.state[key];
  }

  /** 更新单个字段（统一持久化 + 副作用）。 */
  set<K extends keyof AdvancedState>(key: K, value: AdvancedState[K]) {
    this.state[key] = value;
    this.persist();
    if (key === 'fontScale') this.applyFontScale();
    logger.debug('advanced', `${String(key)} = ${String(value)}`);
  }

  /** 界面字号：写到根元素，全局生效（不侵入组件样式）。 */
  private applyFontScale() {
    try {
      document.documentElement.style.setProperty('--font-scale', String(this.state.fontScale));
    } catch {
      /* 非浏览器环境忽略 */
    }
  }

  persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* 静默 */
    }
  }

  reset() {
    this.state = { ...DEFAULT_ADVANCED };
    this.persist();
    this.applyFontScale();
    logger.info('advanced', '已恢复默认高级设置');
  }

  /** 导出为可读 JSON（备份用）。 */
  snapshot(): AdvancedState {
    return { ...this.state };
  }
}

export const advanced = new AdvancedStore();
