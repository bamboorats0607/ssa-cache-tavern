/**
 * 自学习语料通道（self-learning-pipelines · PB1）。// [SSA-LEARN]
 *
 * ── 职责 ──────────────────────────────────────────────────────────────────
 * 把 App 本地的单角色会话（`ChatSession[]`）映射为四通道管线的输入契约
 * `{name, is_user, is_system, mes}`（对齐 v0 离线供给脚本的输入契约）。
 * **单一维护点**（spec C-02）：任何其他模块不得自行拼语料。
 *
 * ── 为什么只吃 `ChatSession[]`（B7，结构性排除）───────────────────────────
 * 群会话的发言人键是 **avatar 文件名**（`default_Seraphina.png`，
 * `group-session-codec.ts:35,53`），而四通道的人名通道要求
 * `/^[\u4e00-\u9fff]{2,4}$/`（`index.js:181`）→ 群语料送进去人名通道**整体失效**，
 * 进而「名归一化 / 人名排除」两处降级，avatar 文件名碎片会被当成主题词污染候选簇。
 * 故本模块**只接受 `ChatSession[]`**：群会话类型在签名上就进不来。
 * 群语料入管线是 Phase 2 独立项（前置「avatar → 显示名」解析）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * · **纯函数**：零 store、零 DOM、零网络；Node 可直接跑（门禁 G0/G1）。
 * · **单向**：会话 → 建议，绝不回注 prompt（C-05 / R14）。
 * · 丢弃字段清单见 `DROPPED_FIELDS`（与 `infra-research/self-learning-pipelines.md` §2.3 对齐）。
 */

import type { ChatSession, StoredTurn } from '../chat-sessions.ts';
import { normalizeSessions } from '../chat-sessions.ts';

/** 用户行固定名（四通道只需一个稳定标识，与 ST 语料惯例一致）。 */
export const CORPUS_USER_NAME = '(user)';

/**
 * 四通道人名通道的采信门槛（**逐字对齐**上游实现，勿各自定义）。
 * 不满足者：该会话的人名通道失效（降级但可用，见 `LearningCorpus.meta.warnings`）。
 */
export const NAME_CHANNEL_PATTERN = /^[\u4e00-\u9fff]{2,4}$/;

/** 丢弃字段清单（审计用；与 infra-research 文档 §2.3 一一对应）。 */
export const DROPPED_FIELDS = [
  'stats',
  'durationMs',
  'model',
  'images',
  'pickReason',
  'id',
  'round',
  'at',
  'title',
  'renamed',
] as const;

/** 四通道输入契约的一条（字段名对齐上游 `readChats()`，勿改大小写/下划线）。 */
export interface CorpusMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
}

/** 名称通道可用性（逐会话上报，防静默降级）。 */
export interface CorpusNameInfo {
  sessionId: string;
  name: string;
  /** 是否满足 `NAME_CHANNEL_PATTERN`（false ⇒ 人名通道对该会话失效） */
  usable: boolean;
}

/** 映射产物。 */
export interface LearningCorpus {
  messages: CorpusMessage[];
  meta: {
    /** 参与映射的会话数 */
    sessions: number;
    /** 参与映射的轮数（turns 总数） */
    turns: number;
    /** 产出的语料条数（= messages.length，冗余存放便于门禁直读） */
    messages: number;
    /** 因文本为空被丢弃的行数（对齐上游 `mes.trim().length>0` 过滤） */
    droppedEmpty: number;
    /** 丢弃字段清单（审计） */
    droppedFields: readonly string[];
    /** 逐会话的名称通道可用性 */
    characterNames: CorpusNameInfo[];
    /** 可读告警（非致命；面板须能显示） */
    warnings: string[];
  };
}

/** 名称是否满足人名通道门槛。 */
export function isNameChannelUsable(name: string): boolean {
  return NAME_CHANNEL_PATTERN.test(name);
}

/**
 * 单个会话 → 语料行（每 turn 展开两条：用户行 → 助手行）。
 *
 * 顺序不变式：按 `round` 升序（对脏数据也成立；`sort` 稳定，同轮保持原序）；
 * 空文本行丢弃并计数（对齐上游 `readChats` 的 `mes.trim().length > 0` 过滤）。
 */
export function flattenSession(session: ChatSession): {
  messages: CorpusMessage[];
  droppedEmpty: number;
} {
  const messages: CorpusMessage[] = [];
  let droppedEmpty = 0;

  const turns = [...(session.turns ?? [])].sort((a, b) => a.round - b.round);
  for (const t of turns) {
    if (isUsableText(t.userText)) {
      messages.push({
        name: CORPUS_USER_NAME,
        is_user: true,
        is_system: false,
        mes: t.userText,
      });
    } else {
      droppedEmpty++;
    }

    if (isUsableText(t.assistantText)) {
      messages.push({
        name: session.characterName,
        is_user: false,
        is_system: false,
        mes: t.assistantText,
      });
    } else {
      droppedEmpty++;
    }
  }

  return { messages, droppedEmpty };
}

/**
 * 多会话 → `LearningCorpus`。
 *
 * 会话按 `createdAt` 升序拼接（保证同输入同输出）；名称通道可用性逐会话上报，
 * 不可用时给出可读告警（降级不静默）。
 */
export function toCorpus(sessions: ChatSession[]): LearningCorpus {
  const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt);
  const messages: CorpusMessage[] = [];
  const characterNames: CorpusNameInfo[] = [];
  const warnings: string[] = [];
  let turns = 0;
  let droppedEmpty = 0;

  for (const s of ordered) {
    const name = typeof s.characterName === 'string' ? s.characterName : '';
    const usable = isNameChannelUsable(name);
    characterNames.push({ sessionId: s.id, name, usable });
    if (!usable) {
      warnings.push(
        `会话「${s.title || s.id}」的角色名「${name || '(空)'}」不满足人名通道门槛 ` +
          '（/^[\\u4e00-\\u9fff]{2,4}$/）：该会话的**人名通道失效**（名归一化 / 人名排除降级），' +
          '核心三通道（n-gram / 共现 / 槽位）仍有效。',
      );
    }

    const r = flattenSession(s);
    turns += s.turns?.length ?? 0;
    droppedEmpty += r.droppedEmpty;
    messages.push(...r.messages);
  }

  if (messages.length === 0) {
    warnings.push('语料为空：没有可用的会话内容，学习不会产出任何建议。');
  }

  return {
    messages,
    meta: {
      sessions: ordered.length,
      turns,
      messages: messages.length,
      droppedEmpty,
      droppedFields: DROPPED_FIELDS,
      characterNames,
      warnings,
    },
  };
}

/** 单轮文本是否非空（与上游过滤同口径：`trim()` 后判空）。 */
export function isUsableText(text: string): boolean {
  return typeof text === 'string' && text.trim().length > 0;
}

/** 类型占位：`StoredTurn` 仅用于文档化映射来源，避免未使用导入告警。 */
export type CorpusSourceTurn = StoredTurn;

// ---------------------------------------------------------------------------
// 语料读取与**角色限定**（P7 / LG-15）
// ---------------------------------------------------------------------------

/** 浏览器存储的最小接口（结构化类型，避免跨模块 import 值）。 */
export interface CorpusStorage {
  getItem(key: string): string | null;
}

/** 单角色会话键（C-02 / R9：群聊记录在 `tavern.groupSessions`，本模块不碰）。 */
export const SESSIONS_KEY = 'tavern.sessions';

/**
 * 读单角色语料。
 *
 * 读取失败**抛出**（由调用方转成 `failed` 态）——不得静默成「零建议」（R-11）。
 * 解析失败单独标注「解析失败」（与「存储不可用」区分开：前者是数据坏了，
 * 后者是环境问题），并说明**未改动任何数据**。
 */
export function readLocalSessions(storage: CorpusStorage | null): ChatSession[] {
  if (!storage) throw new Error('本机存储不可用，读不到会话语料');
  const raw = storage.getItem(SESSIONS_KEY);
  if (!raw) return [];
  try {
    return normalizeSessions(JSON.parse(raw));
  } catch (e) {
    throw new Error(`会话语料解析失败（数据未被改动）：${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface CharacterScope {
  sessions: ChatSession[];
  /** 生效的角色名（null = 未限定，用了全部会话） */
  character: string | null;
  /** 给用户看的一句话（R-11：限定与退回都要**显性**） */
  note: string;
}

/**
 * 按角色限定语料（**跨角色污染的结构性封堵**）。
 *
 * 为什么必须有：`tavern.sessions` 是**一个**键里的**全部**角色的会话，
 * 直接送进管线会让角色 A 学到的簇里混进角色 B 的专名与口头禅。
 * 归属键是 `characterName`（与 `listFor()` 同口径，见 `chat-sessions.ts` 文件头）。
 *
 * `fallback` 决定「拿不到角色名」时的行为 —— 两条路径的要求**不同**：
 * · `'all'`（默认，**手动**点「开始学习」）：学本机全部单角色会话，但**必须显性告知**；
 *   这是用户自己的显式动作，跨角色是知情选择。
 * · `'none'`（**静默**学习路径必须用这个）：宁可不学，也不把其它角色的语料混进来
 *   （A-6 缺陷的封堵点；静默路径没有用户在场，不能"知情"）。
 */
export function scopeToCharacter(
  sessions: ChatSession[],
  characterName: string | null,
  fallback: 'all' | 'none' = 'all',
): CharacterScope {
  const name = typeof characterName === 'string' ? characterName.trim() : '';
  if (!name) {
    if (fallback === 'none') {
      return {
        sessions: [],
        character: null,
        note: '这次会话没有归属角色，静默学习已跳过（避免把其它角色的语料混进来）',
      };
    }
    return {
      sessions,
      character: null,
      note: `没有正在进行的会话，本次学习的是本机全部 ${sessions.length} 个单角色会话`,
    };
  }
  const scoped = sessions.filter((s) => s.characterName === name);
  const others = sessions.length - scoped.length;
  return {
    sessions: scoped,
    character: name,
    note:
      `本次只学《${name}》的 ${scoped.length} 个会话` +
      (others > 0 ? `（本机另有 ${others} 个会话属于其它角色，不参与）` : ''),
  };
}
