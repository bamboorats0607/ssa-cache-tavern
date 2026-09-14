/**
 * 分条渲染 —— 把一条回复切成多个气泡。
 *
 * ── 依据（第 3 轮研究）──────────────────────────────────────────────────
 * 中文即时通讯最显著的特征是**碎片化**：一句话分几条发，极端到一个字、一个标点
 * 单独占一条（全媒派《一句话要分好几条发送》）。这不是排版偏好——它在补偿线上
 * 缺失的语气与表情，并暴露"话还在继续"的状态。AI 的输出天然是一整块，切开就有
 * 一半像人了。
 *
 * ── 为什么只在渲染层切（关键约束）──────────────────────────────────────
 * 消息落盘格式一个字都不改：`turns[].replies[].text` 仍是完整一段。切分是**纯展示**，
 * 因此不碰会话 codec、不影响群聊/单角色的既有持久化与撤销重生成语义。
 *
 * ── 为什么要有长度闸门（防止把小说切碎）────────────────────────────────
 * 酒馆是「聊天 + 描写」两种输出形态混在一起：角色闲聊该碎，成段的场景描写不该碎。
 * 所以只有在**每一段都短**的时候才切——一旦出现长段，就整条按原样渲染。
 */

/** 单段字符上限：超过它就认为这条是叙述/描写，不切。 */
export const BURST_MAX_SEGMENT_CHARS = 140;

/** 单行字符上限：行切模式下每行必须短于它（更严，防把"每句一行"的散文切碎）。 */
export const BURST_MAX_LINE_CHARS = 48;

/** 最多切几条：再多说明这是长回复而不是连发短消息。 */
export const BURST_MAX_SEGMENTS = 6;

/**
 * 把一条回复切成若干个气泡文本。
 *
 * 两条模式，都不满足就返回 `[原文本]`（即不切）：
 *  · **行模式**：没有空行，且每行都短 → 一行一条（最像手机连发）
 *  · **段模式**：以空行分段，段数与前缀都在限内 → 一段一条
 *
 * 纯函数、确定性：同一输入永远同一输出（渲染层可放心直接调用）。
 */
export function splitBurst(text: string): string[] {
  const raw = text.trim();
  if (!raw) return [raw];

  const lines = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const hasBlankLine = /\n\s*\n/.test(raw);

  if (!hasBlankLine) {
    // 行模式：多行、每行都短、条数不多
    if (
      lines.length >= 2 &&
      lines.length <= BURST_MAX_SEGMENTS &&
      lines.every((l) => l.length <= BURST_MAX_LINE_CHARS)
    ) {
      return lines;
    }
    return [raw];
  }

  // 段模式
  const segs = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    segs.length >= 2 &&
    segs.length <= BURST_MAX_SEGMENTS &&
    segs.every((s) => s.length <= BURST_MAX_SEGMENT_CHARS)
  ) {
    return segs;
  }
  return [raw];
}
