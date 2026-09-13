/**
 * API 地址规范化（纯字符串处理，不依赖任何浏览器 API，可被 Node 直接加载）。
 *
 * 背景：多数 OpenAI 兼容端点要求完整路径 `/v1/chat/completions`，
 * 用户常只填到主机名或 `/compatible-mode/v1`，直接请求会被上游以 400 拒绝
 * （实测阿里云返回 InvalidParameter: url error）。此处统一补全，避免踩坑。
 */

/**
 * 把用户填写的 API 地址规范化为完整的 chat/completions 端点。
 *
 * 规则（按顺序）：
 *  1. trim；空串直接返回空串。
 *  2. 去掉全部结尾斜杠。
 *  3. 已含 `/chat/completions` → 原样返回（幂等）。
 *  4. 否则按结尾补全：
 *     - `/compatible-mode/v1` → 补 `/chat/completions`
 *     - `/compatible-mode`    → 补 `/v1/chat/completions`
 *     - `/v1`                 → 补 `/chat/completions`
 *     - 其它（主机名或任意路径）→ 补 `/v1/chat/completions`
 */
export function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // 去掉所有结尾斜杠，便于后续按结尾精确匹配
  const base = trimmed.replace(/\/+$/, '');

  // 幂等：已经填了完整端点就不要再动它
  if (base.includes('/chat/completions')) return base;

  if (base.endsWith('/compatible-mode/v1')) return `${base}/chat/completions`;
  if (base.endsWith('/compatible-mode')) return `${base}/v1/chat/completions`;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;

  return `${base}/v1/chat/completions`;
}
