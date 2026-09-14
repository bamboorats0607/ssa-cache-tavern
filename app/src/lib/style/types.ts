/**
 * 写作风格引擎 —— 类型与档位表。
 *
 * 文案与经验来自本地 Tavo 插件 `deep-reply` v1.5.0（私有目录，不在本仓内），
 * 本目录是**重新实现**（纯函数、可单测），不是代码移植。
 * 研究依据：私有研究笔记「AI 味研究报告」第 1–3 轮（同上，不入本仓）。
 */

/**
 * 尺度上限 —— 语义是「允许写到哪」，不是「要求写到哪」。
 *
 * 这三档都刻意用许可式措辞：第 1 轮研究已确认，把限制写成硬性要求会让输出
 * 变成另一种机械模式；用户要的是上限，不是配额。
 */
export type DepthKey = 'none' | 'mature' | 'explicit' | 'transgressive';

/** 呈现视角 —— 决定「从哪个角度写」，与尺度正交。 */
export type LensKey = 'direct' | 'aftermath' | 'medical' | 'testimony';

/** 风格块的全部输入（决定前缀里那一段文本的每一个字节）。 */
export interface StyleInput {
  /** 聊天体：按「人在手机上聊天」的语用组织对话与叙述 */
  register: boolean;
  /** 尺度上限 */
  depth: DepthKey;
  /** 呈现视角 */
  lens: LensKey;
  /** 风格样本（用户粘的真人文本；空 = 不注入） */
  sample: string;
}

export interface Option<T extends string> {
  key: T;
  label: string;
  hint: string;
}

export const DEPTHS: Option<DepthKey>[] = [
  { key: 'none', label: '不限', hint: '不注入尺度指令' },
  { key: 'mature', label: '成熟', hint: '该露就露，不回避也不扩写' },
  { key: 'explicit', label: '直白', hint: '过程写完整，不用比喻绕开' },
  { key: 'transgressive', label: '不留余地', hint: '可以写崩坏与不可逆的伤害' },
];

export const LENSES: Option<LensKey>[] = [
  { key: 'direct', label: '正面', hint: '不注入视角指令' },
  { key: 'aftermath', label: '余波', hint: '重点在事后，过程一句带过' },
  { key: 'medical', label: '医案', hint: '冷静精确地写身体与处置' },
  { key: 'testimony', label: '证词', hint: '事后第一人称回忆，允许记忆错位' },
];
