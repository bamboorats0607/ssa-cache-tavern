/**
 * 聊天客户端 —— 对接 SillyBunny 的 `/api/backends/chat-completions/generate`。
 *
 * ── 为什么走后端而不是直连大模型 ─────────────────────────────────────────
 * 架构基座已拍板：保留 SillyBunny 后端契约（不 fork 后端）。
 * 因此前端只认这一个端点，由后端负责各家 provider 的差异、密钥保管、
 * 缓存断点等。这样 App 侧零 provider 分支，换模型不用改前端。
 *
 * ── 契约（逐字段取证，非臆测）────────────────────────────────────────────
 * · 端点：`src/endpoints/backends/chat-completions.js:3578` → `router.post('/generate', …)`
 * · 请求体字段：`public/scripts/openai.js:5241-5268`
 * · CSRF：`src/server-main.js:330-366`（保护开启时需 `X-CSRF-Token`），
 *   取 token：`GET /csrf-token`（同文件 355-360）
 * · 响应：非流式 = 标准 chat completion JSON；
 *   流式 = `text/event-stream`，逐条 `data: {...}`，以 `data: [DONE]` 结束
 *   （`public/scripts/openai.js:5613-5649`）
 */

import { getBaseUrl } from './backend';
import { logger } from './logger';

/**
 * 消息内容部件。
 *
 * 纯文本消息仍用 `string`；携带图片的消息改用部件数组 ——
 * 后端 `messages[].content` 原生支持数组形态，无需在 `buildBody()` 做转换。
 *
 * 图片部件格式严格为 `{type:'image_url', image_url:{url}}`，`url` 必须是
 * **data URL（base64 内联）**，后端不接受本地文件路径。
 * 取证：`public/scripts/openai.js:6150`。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  /** 普通消息为字符串；带图消息为部件数组（见 ContentPart） */
  content: string | ContentPart[];
}

export interface GenerateOptions {
  messages: ChatTurn[];
  model: string;
  temperature: number;
  frequencyPenalty: number;
  presencePenalty: number;
  topP: number;
  maxTokens: number;
  stream: boolean;
  /**
   * 是否开启思考模式 → 上游 `enable_thinking`。
   *
   * 百炼系模型（deepseek-v4 / glm-5.2 / qwen3.x）默认**开**思考，实测两个坑：
   *   1) 思考阶段 `delta.content` 为空（dashscope 为 `null`，token-plan 为 `""`），
   *      正文要等思考完才出 —— 期间界面必须给占位反馈。
   *   2) **思维链与正文共享 max_tokens**。max_tokens=60 时 deepseek-v4-pro 与
   *      glm-5.2 的预算全被思维链吃光，正文为空（finish_reason=length）。
   * 角色扮演场景不需要思考，显式传 false 更快更省，也避免"只思考不说话"。
   */
  thinking?: boolean;
  /** chat_completion_source，默认 'custom'（自建/兼容端点） */
  source?: string;
  /** custom 源的目标地址 */
  customUrl?: string;
  /** 模型 API 密钥；由后端转成 Authorization: Bearer 头 */
  apiKey?: string;
  userName?: string;
  charName?: string;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  /** 思维链内容（DeepSeek/Qwen 等走 reasoning_content 字段；无则为空） */
  reasoning?: string;
  usage?: TokenUsage;
}

/** token 用量（字段名逐项实测取证，非臆测）。 */
export interface TokenUsage {
  /** 输入 token */
  promptTokens?: number;
  /** 输出 token */
  completionTokens?: number;
  /** 输入中被缓存命中（按缓存价计费）的 token —— 核心成本指标 */
  cachedTokens?: number;
  /** 本轮总计 */
  totalTokens?: number;
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

let csrfToken: string | null = null;
let csrfInflight: Promise<string | null> | null = null;
/** 后端没有 /csrf-token（如内置降级 API）时置位，避免每次发送都白跑一趟。 */
let csrfUnsupported = false;

/**
 * 取 CSRF token。后端未开启保护时返回 'disabled'（server-main.js:371），
 * 此时照常带上也无害；若后端根本没有该端点，则返回 null 并记住不再重试。
 */
export async function getCsrfToken(force = false): Promise<string | null> {
  if (csrfUnsupported && !force) return null;
  if (csrfToken && !force) return csrfToken;
  if (csrfInflight && !force) return csrfInflight;

  csrfInflight = (async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/csrf-token`, {
        cache: 'no-store',
        credentials: 'include',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        // 404 = 该后端没有 CSRF 端点（降级 API），后续不再尝试
        if (res.status === 404) csrfUnsupported = true;
        logger.debug('chat', 'CSRF 取用未成功', { status: res.status });
        return null;
      }
      const data = (await res.json()) as { token?: string };
      csrfToken = data.token ?? null;
      return csrfToken;
    } catch (e) {
      logger.debug('chat', 'CSRF 请求异常', e);
      return null;
    } finally {
      csrfInflight = null;
    }
  })();

  return csrfInflight;
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 组装请求体（字段名严格对齐 openai.js:5241-5268）。 */
function buildBody(o: GenerateOptions): Record<string, unknown> {
  const source = o.source ?? 'custom';
  const body: Record<string, unknown> = {
    type: 'chat',
    chat_completion_source: source,
    messages: o.messages,
    model: o.model,
    temperature: Number(o.temperature),
    frequency_penalty: Number(o.frequencyPenalty),
    presence_penalty: Number(o.presencePenalty),
    top_p: Number(o.topP),
    max_tokens: Number(o.maxTokens),
    stream: o.stream,
    // 流式下必须显式请求用量帧，否则上游不回 usage（实测：不带此项时流里无 usage 字段）。
    // 用量出现在末尾一个 `choices: []` 的帧里，由 streamReply 捕获。
    ...(o.stream ? { stream_options: { include_usage: true } } : {}),
    // 显式下发，避免上游默认开思考导致「预算被思维链吃光、正文为空」
    enable_thinking: o.thinking ?? false,
    user_name: o.userName ?? '用户',
    char_name: o.charName ?? '角色',
    cacheScope: 'main',
  };
  if (source === 'custom' && o.customUrl) {
    body.custom_url = o.customUrl;
  }
  if (o.apiKey) {
    body.api_key = o.apiKey;
  }
  return body;
}

/**
 * 发送并生成回复。
 *
 * @param onDelta 流式增量回调：每收到一段文本即调用（拼接后的全文）。
 */
export async function generateReply(
  o: GenerateOptions,
  onDelta?: (fullText: string) => void,
): Promise<GenerateResult> {
  const token = await getCsrfToken();
  const url = `${getBaseUrl()}/api/backends/chat-completions/generate`;

  logger.info('chat', '发起生成', {
    model: o.model,
    stream: o.stream,
    turns: o.messages.length,
    source: o.source ?? 'custom',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-CSRF-Token': token } : {}),
    },
    body: JSON.stringify(buildBody(o)),
    signal: o.signal,
  });

  if (!res.ok) {
    // 401/403 多半是 CSRF 轮换（后端重启），强制刷新后由调用方重试
    const detail = await res.text().catch(() => '');
    logger.error('chat', '生成失败', { status: res.status, detail: detail.slice(0, 300) });
    throw new Error(`生成请求失败（${res.status}）。${detail.slice(0, 200)}`);
  }

  const isStream =
    o.stream && (res.headers.get('Content-Type') ?? '').includes('text/event-stream');

  if (!isStream) {
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      error?: { message?: string };
      usage?: Record<string, unknown>;
    };
    if (data.error) throw new Error(data.error.message ?? '模型返回错误');
    const text = data.choices?.[0]?.message?.content ?? '';
    onDelta?.(text);
    return {
      text,
      reasoning: data.choices?.[0]?.message?.reasoning_content,
      usage: normalizeUsage(data.usage),
    };
  }

  return streamReply(res, onDelta);
}

/** 解析 SSE 流（标准 `data: <json>` + `data: [DONE]`）。 */
async function streamReply(
  res: Response,
  onDelta?: (full: string) => void,
): Promise<GenerateResult> {
  if (!res.body) throw new Error('响应无 body，无法流式读取');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let reasoning = '';
  let usage: GenerateResult['usage'];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 上游可能用 \r\n 分隔，统一归一后再按行切
    buffer = buffer.replace(/\r\n/g, '\n');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let parsed: {
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
        error?: { message?: string };
        usage?: Record<string, unknown>;
      };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // 不完整分片，忽略
      }

      if (parsed.error) throw new Error(parsed.error.message ?? '模型返回错误');
      // 用量帧：`choices: []`（可能是空数组），故不能用 choices[0] 是否存在来判断
      if (parsed.usage) usage = normalizeUsage(parsed.usage);

      const delta = parsed.choices?.[0]?.delta;
      // 思考阶段：上游用 reasoning_content 承载，且此时 content 为 null。
      // 若只读 content，思考期间界面会一直是空白（实测踩过此坑）。
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.content) {
        full += delta.content;
        onDelta?.(full);
      }
    }
  }

  logger.info('chat', '生成完成', {
    chars: full.length,
    reasoningChars: reasoning.length,
    cached: usage?.cachedTokens,
  });
  return { text: full, reasoning: reasoning || undefined, usage };
}

/**
 * 归一化上游 usage 字段。
 *
 * ⚠️ 缓存字段名实测取证（2026-09-12，token-plan 端点 deepseek-v4-flash-0731）：
 *   正确的字段是 `usage.prompt_tokens_details.cached_tokens`。
 *   旧实现读 `prompt_cache_hit_tokens`（那是 DeepSeek 直连 API 的字段名），
 *   在本端点**恒为 undefined** → 缓存命中永远显示为 0。
 *   实测样本：
 *     {"prompt_tokens":1129,"total_tokens":1137,"completion_tokens":8,
 *      "prompt_tokens_details":{"cached_tokens":1024}}
 *   同时保留 `prompt_cache_hit_tokens` 作为回退，兼容其它 provider。
 */
function normalizeUsage(u?: Record<string, unknown>): TokenUsage | undefined {
  if (!u) return undefined;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, number>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
    cachedTokens: num(details.cached_tokens) ?? num(u.prompt_cache_hit_tokens),
  };
}
