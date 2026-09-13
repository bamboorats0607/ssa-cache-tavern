/**
 * 模型与采样参数 store。
 *
 * 字段对齐 SillyBunny `oai_settings`（实测清单，见 openai.js:547-572）：
 *   temp_openai / top_p_openai / freq_pen_openai / pres_pen_openai
 *   openai_max_context / openai_max_tokens / openai_model / stream_openai
 * 加上 ST 通用项：max_context / amount_gen / rep_pen
 */

import { logger } from '../lib/logger';

const KEY = 'tavern.model';

export interface ModelConfig {
  /** 本机后端端点（固定指向内嵌后端，一般无需改） */
  endpoint: string;
  /** 真实模型 API 地址（OpenAI 兼容），经后端代理转发 */
  apiUrl: string;
  /** 模型 API 密钥（仅存本机，随请求头转发） */
  apiKey: string;
  /** 模型名 */
  model: string;
  /** 预设名 */
  preset: string;
  /** 用户名（替换 {{user}}） */
  userName: string;

  // —— 采样参数（SillyBunny 字段名对齐）——
  temp: number;
  topP: number;
  topK: number;
  minP: number;
  freqPen: number;
  presPen: number;
  repPen: number;
  /** 随机种子：-1 = 每次随机 */
  seed: number;

  // —— 长度参数 ——
  maxContext: number;
  maxTokens: number;
  stream: boolean;
  /**
   * 是否开启模型的思考模式（对齐百炼的 `enable_thinking`）。
   *
   * 默认**关**，因为实测思考模式会吃掉输出预算：
   * 同一提示、max_tokens=60 时，deepseek-v4-pro / glm-5.2 的 60 个 token
   * 全被思维链耗尽，正文为空（finish_reason=length）；qwen3.6-flash 更是
   * 烧掉 726 个推理 token。角色扮演不需要思考，且首字延迟明显更长。
   */
  thinking: boolean;
}

export const DEFAULT_MODEL: ModelConfig = {
  endpoint: 'http://127.0.0.1:4444/api/backends/chat-completions',
  // 默认指向阿里云百炼（DashScope）OpenAI 兼容端点。
  // 注意：端点必须与密钥配套 —— 百炼通用密钥（sk- 开头）配 dashscope 域名；
  // Token Plan 套餐密钥（sk-sp- 开头）配 token-plan.*.maas.aliyuncs.com，
  // 两者混用会 401（2026-09 实测：同一 sk- 密钥打 token-plan 端点 401，
  // 打 dashscope 端点 200）。
  apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  apiKey: '',
  model: 'deepseek-v4-flash-0731',
  preset: '默认',
  userName: '用户',

  temp: 1.0,
  topP: 1.0,
  topK: 0,
  minP: 0,
  freqPen: 0,
  presPen: 0,
  repPen: 1.0,
  seed: -1,

  maxContext: 8192,
  maxTokens: 300,
  stream: true,
  thinking: false,
};

function load(): ModelConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_MODEL };
    return { ...DEFAULT_MODEL, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_MODEL };
  }
}

class ModelStore {
  endpoint = $state(DEFAULT_MODEL.endpoint);
  apiUrl = $state(DEFAULT_MODEL.apiUrl);
  apiKey = $state(DEFAULT_MODEL.apiKey);
  model = $state(DEFAULT_MODEL.model);
  preset = $state(DEFAULT_MODEL.preset);
  userName = $state(DEFAULT_MODEL.userName);

  temp = $state(DEFAULT_MODEL.temp);
  topP = $state(DEFAULT_MODEL.topP);
  topK = $state(DEFAULT_MODEL.topK);
  minP = $state(DEFAULT_MODEL.minP);
  freqPen = $state(DEFAULT_MODEL.freqPen);
  presPen = $state(DEFAULT_MODEL.presPen);
  repPen = $state(DEFAULT_MODEL.repPen);
  seed = $state(DEFAULT_MODEL.seed);

  maxContext = $state(DEFAULT_MODEL.maxContext);
  maxTokens = $state(DEFAULT_MODEL.maxTokens);
  stream = $state(DEFAULT_MODEL.stream);
  thinking = $state(DEFAULT_MODEL.thinking);

  constructor() {
    Object.assign(this, load());
  }

  snapshot(): ModelConfig {
    return {
      endpoint: this.endpoint,
      apiUrl: this.apiUrl,
      apiKey: this.apiKey,
      model: this.model,
      preset: this.preset,
      userName: this.userName,
      temp: this.temp,
      topP: this.topP,
      topK: this.topK,
      minP: this.minP,
      freqPen: this.freqPen,
      presPen: this.presPen,
      repPen: this.repPen,
      seed: this.seed,
      maxContext: this.maxContext,
      maxTokens: this.maxTokens,
      stream: this.stream,
      thinking: this.thinking,
    };
  }

  persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.snapshot()));
    } catch {
      /* 静默 */
    }
  }

  /** 更新单个字段（统一持久化 + 记日志）。 */
  set<K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) {
    // @ts-expect-error 动态键赋值
    this[key] = value;
    this.persist();
    logger.debug('model', `${String(key)} = ${String(value)}`);
  }

  reset() {
    Object.assign(this, DEFAULT_MODEL);
    this.persist();
    logger.info('model', '已恢复默认参数');
  }
}

export const modelConfig = new ModelStore();
