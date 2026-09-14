/**
 * 风格块生成 —— 纯函数、确定性。
 *
 * ── 为什么必须是纯函数（不是洁癖）──────────────────────────────────────
 * 风格块进的是**前缀冻结区**（spec R1：会话内一个字节都不许变）。任何非确定性
 * 来源（时间戳、随机数、对象键序、本地化默认值）都会让前缀每轮变一字节，整段
 * KV 缓存作废。所以本模块只做字符串拼接，且输入相同 → 输出逐字节相同。
 * `styleFingerprint` 就是这条性质的机器可判定形式（单测/e2e 门禁用它）。
 */

import { estimateTokens } from '../context/assembler.ts';
import {
  CHAT_BLOCK,
  DEPTH_BLOCKS,
  LENS_BLOCKS,
  NARRATION_BLOCK,
  SAMPLE_HEADER,
} from './presets.ts';
import type { StyleInput } from './types.ts';

/** 样本字符上限。样本会随轮数反复计费（命中价低但非零），且边际收益随长度递减。 */
export const SAMPLE_MAX_CHARS = 1200;

/** 风格块 token 建议上限（含样本）。设置页超出时给提示，不静默截断。 */
export const GUIDE_TOKEN_BUDGET = 500;

/**
 * 样本归一化：把用户粘贴的文本压成稳定形态。
 *
 * 做三件事：换行统一为 `\n`（Windows 粘贴常带 `\r`）、去掉行尾空白、折叠连续空行。
 * 归一化必须在**写入前**做：否则同一个样本在不同平台粘贴会得到不同字节，
 * 前缀稳定性就取决于用户在哪个设备上操作了。
 */
export function normalizeSample(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, SAMPLE_MAX_CHARS)
    .trim();
}

/**
 * 生成风格块。默认态（只开 register）返回聊天体两段；全关且无样本时返回空串。
 *
 * 块序固定：说话方式 → 叙述 → 尺度 → 视角 → 语感参照。
 * 语感参照放最后：它离正文最近，是 few-shot 锚点（第 1 轮结论：样本比形容词有效）。
 */
export function buildStyleGuide(input: StyleInput): string {
  const blocks: string[] = [];

  if (input.register) blocks.push(CHAT_BLOCK, NARRATION_BLOCK);

  const depth = DEPTH_BLOCKS[input.depth];
  if (depth) blocks.push(depth);

  const lens = LENS_BLOCKS[input.lens];
  if (lens) blocks.push(lens);

  const sample = normalizeSample(input.sample);
  if (sample) blocks.push(`${SAMPLE_HEADER}\n${sample}`);

  return blocks.join('\n\n');
}

/**
 * 稳定指纹（FNV-1a 32 位）。用途有二：
 *  · 单测/e2e 断言「同一输入 → 同一字节」；
 *  · 设置页判断「改完会不会击穿前缀缓存」。
 */
export function styleFingerprint(input: StyleInput): string {
  const s = buildStyleGuide(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 风格块的 token 估算（与消息统计同口径）。设置页显示用。 */
export function styleTokens(input: StyleInput): number {
  return estimateTokens(buildStyleGuide(input));
}

/** 一句话摘要，用于设置页与主页右侧的当前值显示。 */
export function describeStyle(input: StyleInput, labels: {
  depth: (k: StyleInput['depth']) => string;
  lens: (k: StyleInput['lens']) => string;
}): string {
  const parts: string[] = [];
  parts.push(input.register ? '聊天体' : '不做风格约束');
  if (DEPTH_BLOCKS[input.depth]) parts.push(`尺度·${labels.depth(input.depth)}`);
  if (LENS_BLOCKS[input.lens]) parts.push(`视角·${labels.lens(input.lens)}`);
  if (normalizeSample(input.sample)) parts.push('含样本');
  return parts.join(' · ');
}
