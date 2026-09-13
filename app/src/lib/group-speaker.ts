/**
 * 群聊发言人选择：**确定性状态机**（纯函数，可 Node 直跑）。// [SSA-GROUP]
 *
 * ── 为什么不调用模型（spec C-10）──────────────────────────────────────────
 * 「每轮额外一次调用让模型选谁说话」（对标 Tavo）会带来三个代价：
 *   1) 成本：每轮多一次请求；2) 延迟：群聊节奏被拉长；
 *   3) 可用性：模型端不可用时**群聊直接停摆**（本项目实测过内嵌后端
 *      「端口 LISTEN 但不应答」的窗口）。
 * 因此默认走**本地确定性规则**：给定同样的输入，永远选出同一个人——
 * 可解释、可复现、可单测；LLM 选人留作可选开关（默认关）。
 *
 * ── 规则来源 ──────────────────────────────────────────────────────────────
 * `group-network.ts` 提供静态数据（关系矩阵 / 基准优先级 / 触发位掩码），
 * 本模块只做「本轮事件 → 打分 → 取最大」，O(N) 一趟。
 * 关系/优先级/触发**一律不进 prompt**（spec R14）——它们只影响「谁说话」。
 *
 * ── 确定性保证 ────────────────────────────────────────────────────────────
 * 取最大的比较顺序固定：`score` → `idleTurns` 更大者 → 下标更小者。
 * 不含随机数、不读时间、不依赖对象键顺序（成员一律按 `network.keys` 索引遍历）。
 */

import {
  hasTrigger,
  memberIndexOf,
  relationOf,
  TRIGGER,
  type GroupNetwork,
} from './group-network';

/** 触发事件权重（编译期常量；改这里即改「谁更该说话」的倾向）。 */
const W = {
  /** 手动强制（点头像让 TA 说）——最高优先，直接选定，不参与比较 */
  FORCED: Number.POSITIVE_INFINITY,
  /** 被用户点名 */
  MENTIONED_BY_USER: 1000,
  /** 被上一发言者提及（对应 Tavo 的「角色提及时回复」） */
  MENTIONED_BY_SPEAKER: 120,
  /** 用户刚回复了 TA（延续对话） */
  USER_REPLIED_TO_ME: 80,
  /** 关键词命中（该成员的世界书 key / 角色 tag） */
  KEYWORD_HIT: 60,
  /** 连续 N 轮未发言（轮空补偿） */
  IDLE_TURNS: 40,
  /** 沉默超时兜底 */
  SILENCE_TIMEOUT: 30,
  /** 与上一发言者关系强度超阈值 */
  RELATION_EDGE: 20,
  /** 关系值折算系数：score += relation × 该系数（值域 −100..100） */
  RELATION_SCALE: 0.25,
  /** 上一发言者再次连说的惩罚（防同一人霸屏） */
  REPEAT_PENALTY: 25,
} as const;

/** 判定「关系强度超阈值」的阈值（绝对值）。 */
export const RELATION_EDGE_THRESHOLD = 60;
/** 判定「连续 N 轮未发言」的 N。 */
export const IDLE_TURNS_THRESHOLD = 2;
/** 判定「全局沉默超时」的 M。 */
export const SILENCE_TIMEOUT_TURNS = 4;

/** 本轮事件（由调用方从最近的对话里算出；本模块只消费）。 */
export interface SpeakerEvents {
  /** 用户本条消息里点名的人（@）——**只允许一个**，多个时取第一个 */
  mentionedByUserKey?: string | null;
  /** 上一发言者的 key（首轮为 null） */
  lastSpeakerKey?: string | null;
  /** 上一发言者文本里被提及的成员 key（调用方用显示名匹配后传入） */
  mentionedBySpeakerKeys?: string[];
  /** 关键词命中的成员 key（调用方用世界书 key / 角色 tag 判定后传入） */
  keywordHitKeys?: string[];
  /** 用户刚回复的成员 key（上一条 assistant 的作者） */
  userRepliedToKey?: string | null;
  /** 每成员距上次发言的轮数；未发言过者由调用方给一个大值（见 UNSEEN_IDLE_TURNS） */
  idleTurns?: Record<string, number>;
  /** 手动强制（点头像 / 点快捷发言按钮） */
  forcedKey?: string | null;
}

/** 「从未发过言」的 idle 值（足够大以触发轮空补偿）。 */
export const UNSEEN_IDLE_TURNS = 999;

export interface PickSpeakerInput {
  network: GroupNetwork;
  /** 静音成员（不参与选择；对应上游 disabled_members 的语义） */
  mutedKeys?: string[];
  events: SpeakerEvents;
}

export interface PickSpeakerResult {
  /** 选中的成员 key；无可用成员时为 null */
  speakerKey: string | null;
  /** 可解释原因（写入 `GroupTurn.pickReason`；**禁止注入 prompt**） */
  reason: string;
  /** 各成员得分（降序，供调试与单测） */
  scores: { key: string; score: number; why: string[] }[];
}

/** 某个引马尔可夫式打分：把命中的事件折算成分数，并记录原因（便于解释与排错）。 */
function scoreMember(
  network: GroupNetwork,
  index: number,
  key: string,
  lastIndex: number,
  events: SpeakerEvents,
): { score: number; why: string[] } {
  let score = network.priority[index] ?? 0;
  const why: string[] = [];

  if (events.mentionedByUserKey === key && hasTrigger(network, index, TRIGGER.MENTIONED_BY_USER)) {
    score += W.MENTIONED_BY_USER;
    why.push('被点名');
  }
  if (
    hasTrigger(network, index, TRIGGER.MENTIONED_BY_SPEAKER) &&
    (events.mentionedBySpeakerKeys ?? []).includes(key)
  ) {
    score += W.MENTIONED_BY_SPEAKER;
    why.push('被上一位提及');
  }
  if (events.userRepliedToKey === key && hasTrigger(network, index, TRIGGER.USER_REPLIED_TO_ME)) {
    score += W.USER_REPLIED_TO_ME;
    why.push('用户刚回复了 TA');
  }
  if (hasTrigger(network, index, TRIGGER.KEYWORD_HIT) && (events.keywordHitKeys ?? []).includes(key)) {
    score += W.KEYWORD_HIT;
    why.push('关键词命中');
  }

  const idle = events.idleTurns?.[key] ?? 0;
  if (idle >= IDLE_TURNS_THRESHOLD) {
    if (hasTrigger(network, index, TRIGGER.IDLE_TURNS)) {
      score += W.IDLE_TURNS;
      why.push(`轮空 ${idle} 轮`);
    }
    if (idle >= SILENCE_TIMEOUT_TURNS && hasTrigger(network, index, TRIGGER.SILENCE_TIMEOUT)) {
      score += W.SILENCE_TIMEOUT;
      why.push('沉默兜底');
    }
  }

  if (lastIndex >= 0) {
    const rel = relationOf(network, index, lastIndex);
    if (rel !== 0) {
      score += rel * W.RELATION_SCALE;
      why.push(`对上一发言者关系 ${rel}`);
    }
    if (Math.abs(rel) >= RELATION_EDGE_THRESHOLD && hasTrigger(network, index, TRIGGER.RELATION_EDGE)) {
      score += W.RELATION_EDGE;
      why.push('关系强触发');
    }
    if (index === lastIndex) {
      score -= W.REPEAT_PENALTY;
      why.push('连说惩罚');
    }
  }

  return { score, why };
}

/**
 * 选出本轮发言人。
 *
 * 优先级：手动强制 → 被用户点名 → 其余按打分取最大（同分用「轮空更久」→「下标更小」兜底）。
 * 全部成员被静音（或无成员）时返回 `speakerKey: null`。
 */
export function pickSpeaker(input: PickSpeakerInput): PickSpeakerResult {
  const { network, events } = input;
  const muted = new Set(input.mutedKeys ?? []);
  const keys = network.keys;
  const n = keys.length;
  const empty: PickSpeakerResult = { speakerKey: null, reason: '无可用成员', scores: [] };
  if (n === 0) return empty;

  const lastIndex = events.lastSpeakerKey ? memberIndexOf(network, events.lastSpeakerKey) : -1;

  // 1) 手动强制（最高优先；即使该成员「没有 FORCED 触发位」也以显式意图为准）
  const forced = events.forcedKey;
  if (forced && !muted.has(forced) && keys.includes(forced)) {
    return { speakerKey: forced, reason: `${forced}：手动指定`, scores: [] };
  }

  // 2) 被用户点名（Tavo 的「点击让 TA 说话」在语义上的近亲：显式指定优先于统计）
  const mentioned = events.mentionedByUserKey;
  if (mentioned && !muted.has(mentioned) && keys.includes(mentioned)) {
    const i = memberIndexOf(network, mentioned);
    if (hasTrigger(network, i, TRIGGER.MENTIONED_BY_USER)) {
      return { speakerKey: mentioned, reason: `${mentioned}：被用户点名`, scores: [] };
    }
  }

  // 3) 打分取最大
  const scored: { key: string; score: number; why: string[]; index: number; idle: number }[] = [];
  for (let i = 0; i < n; i++) {
    const key = keys[i];
    if (muted.has(key)) continue;
    const { score, why } = scoreMember(network, i, key, lastIndex, events);
    scored.push({ key, score, why, index: i, idle: events.idleTurns?.[key] ?? 0 });
  }
  if (scored.length === 0) return empty;

  // 确定性排序：score ↓ → idle ↓ → index ↑（不含随机，不含对象键顺序依赖）
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.idle !== a.idle) return b.idle - a.idle;
    return a.index - b.index;
  });

  const win = scored[0];
  const reason = win.why.length > 0 ? `${win.key}：${win.why.join(' + ')}` : `${win.key}：默认轮转`;
  return {
    speakerKey: win.key,
    reason,
    scores: scored.map((s) => ({ key: s.key, score: s.score, why: s.why })),
  };
}

/**
 * 从「上一轮已发言者」推进 `idleTurns`（每轮调用一次，纯函数）。
 * 被选中者归零，其余 +1；首次出现的成员按 `UNSEEN_IDLE_TURNS` 起步（促使其尽早开口）。
 */
export function advanceIdle(
  idleTurns: Record<string, number>,
  memberKeys: string[],
  spokeKey: string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of memberKeys) {
    const prev = idleTurns[k] ?? UNSEEN_IDLE_TURNS;
    out[k] = k === spokeKey ? 0 : prev + 1;
  }
  return out;
}
