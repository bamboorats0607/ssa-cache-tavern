/**
 * 群聊 store：群元数据 + 群会话（**独立键、零后端写依赖**，spec 终局 B 形态）。// [SSA-GROUP]
 *
 * ── 为什么两个键（而不是一个）─────────────────────────────────────────────
 * `tavern.groups`          —— 群元数据 + 角色网络（小体积、**低频写**：建群/改名/改成员/静音）
 * `tavern.groupSessions`   —— 群会话与轮次（大体积、**每轮写**）
 * 分开的三个收益：
 *   1) 一个键写失败**不会连带丢另一个**（配额是整键写失败的）；
 *   2) 每轮只重写轮次键，元数据键不动 → 减少无谓序列化；
 *   3) 群记录不挤占单角色会话的配额（spec R9：断言不写 `tavern.sessions`）。
 *
 * ── 硬约束 ────────────────────────────────────────────────────────────────
 * · C-02：与 `tavern.sessions` **物理隔离**（本模块只读写上面两个键）；
 * · C-03：群记录禁带 data URL 图片（`GroupTurn` 结构上就没有 images 字段）；
 * · C-04/R8：**写失败必须显性提示**（`lastError`），不得静默 —— 与单角色既有行为不同，
 *   单角色路径本模块**完全不碰**，其行为保持原样；
 * · R12/C-11：不暴露上游 `generation_mode / activation_strategy / conversation_settings`。
 */

import { logger } from '../lib/logger';
import {
  byGroupRecency,
  countGroupReplies,
  countGroupTurns,
  decodeGroupSessions,
  encodeGroupSessions,
  GROUP_CODEC_VERSION,
  MAX_GROUP_SESSIONS,
  normalizeGroupSessions,
  pruneGroupSessions,
  pruneGroupTurns,
  UNTITLED_GROUP_SESSION,
  type GroupReply,
  type GroupSessionRecord,
  type GroupTurn,
} from '../lib/group-session-codec';
import {
  defaultNetwork,
  normalizeNetwork,
  resizeNetwork,
  type GroupNetwork,
} from '../lib/group-network';

const GROUPS_KEY = 'tavern.groups';
const SESSIONS_KEY = 'tavern.groupSessions';

/** 群元数据（含发言人规则网络；不含任何消息）。 */
export interface Group {
  id: string;
  name: string;
  /** 成员：角色头像文件名（顺序即网络矩阵下标） */
  memberKeys: string[];
  /** 静音成员（不参与发言人选择） */
  mutedKeys: string[];
  /** 角色网络 + 触发矩阵（静态规则数据；**禁止注入 prompt**，spec R14） */
  network: GroupNetwork;
  createdAt: number;
  updatedAt: number;
}

interface GroupsFile {
  v: number;
  activeGroupId: string | null;
  groups: Group[];
}

/** 新建群/改成员时的默认群名。 */
export const DEFAULT_GROUP_NAME = '新群聊';

function loadGroups(): GroupsFile {
  const empty: GroupsFile = { v: GROUP_CODEC_VERSION, activeGroupId: null, groups: [] };
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<GroupsFile>;
    const groups = Array.isArray(parsed.groups)
      ? parsed.groups
          .filter((g): g is Group => !!g && typeof g === 'object' && typeof (g as Group).id === 'string')
          .map((g) => {
            const memberKeys = Array.isArray(g.memberKeys)
              ? g.memberKeys.filter((k): k is string => typeof k === 'string' && k.length > 0)
              : [];
            return {
              id: g.id,
              name: typeof g.name === 'string' && g.name ? g.name : DEFAULT_GROUP_NAME,
              memberKeys,
              mutedKeys: Array.isArray(g.mutedKeys)
                ? g.mutedKeys.filter((k): k is string => typeof k === 'string')
                : [],
              // 网络数据必须与 memberKeys 对齐（长度不符会被归一化重建）
              network: normalizeNetwork(g.network, memberKeys),
              createdAt: typeof g.createdAt === 'number' ? g.createdAt : Date.now(),
              updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : Date.now(),
            };
          })
      : [];
    return {
      v: GROUP_CODEC_VERSION,
      activeGroupId: typeof parsed.activeGroupId === 'string' ? parsed.activeGroupId : null,
      groups,
    };
  } catch {
    return empty;
  }
}

class GroupsStore {
  /** 群元数据（响应式） */
  groups = $state<Group[]>([]);
  /** 当前激活群 */
  activeGroupId = $state<string | null>(null);
  /** 群会话与轮次（独立键） */
  sessions = $state<GroupSessionRecord[]>([]);
  /**
   * 写失败提示（C-04/R8：**显性**，不静默）。
   * 值为面向用户的中文说明；成功后清空。
   */
  lastError = $state<string | null>(null);

  constructor() {
    const file = loadGroups();
    this.groups = file.groups;
    this.activeGroupId =
      file.activeGroupId && file.groups.some((g) => g.id === file.activeGroupId)
        ? file.activeGroupId
        : (file.groups[0]?.id ?? null);
    try {
      this.sessions = pruneGroupSessions(decodeGroupSessions(localStorage.getItem(SESSIONS_KEY)));
    } catch {
      this.sessions = [];
    }
  }

  /** 当前激活群（无则 null）。 */
  get active(): Group | null {
    return this.groups.find((g) => g.id === this.activeGroupId) ?? null;
  }

  /** 群名（UI 展示用）。 */
  nameOf(groupId: string): string {
    return this.groups.find((g) => g.id === groupId)?.name ?? DEFAULT_GROUP_NAME;
  }

  // ── 持久化（两个键各自独立；失败**显性**提示）────────────────────────────
  private persistGroups(): boolean {
    try {
      localStorage.setItem(
        GROUPS_KEY,
        JSON.stringify({ v: GROUP_CODEC_VERSION, activeGroupId: this.activeGroupId, groups: this.groups }),
      );
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = '群设置保存失败（可能超出存储配额）——请删除不用的群聊后重试';
      logger.warn('groups', '群元数据持久化失败', e);
      return false;
    }
  }

  private persistSessions(): boolean {
    try {
      localStorage.setItem(SESSIONS_KEY, encodeGroupSessions(this.sessions));
      this.lastError = null;
      return true;
    } catch (e) {
      // 群聊记录比单角色大（一轮含多条发言），更易触顶；必须让用户看见（C-04）
      this.lastError = '群聊记录保存失败（可能超出存储配额）——请删除较旧的群聊后重试';
      logger.warn('groups', '群会话持久化失败（可能超出存储配额）', e);
      return false;
    }
  }

  // ── 群管理 ───────────────────────────────────────────────────────────────
  /**
   * 建群。成员少于 2 人时仍允许（可后续加人），但 UI 层应提示「至少两人才能开聊」。
   * @returns 新群 id
   */
  create(name: string, memberKeys: string[]): string {
    const now = Date.now();
    const id = `g_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const group: Group = {
      id,
      name: name.trim() || DEFAULT_GROUP_NAME,
      memberKeys: [...memberKeys],
      mutedKeys: [],
      network: defaultNetwork(memberKeys),
      createdAt: now,
      updatedAt: now,
    };
    this.groups = [...this.groups, group];
    this.activeGroupId = id;
    this.persistGroups();
    logger.info('groups', '已建群', { id, members: memberKeys.length });
    return id;
  }

  /** 改名。 */
  rename(groupId: string, name: string): void {
    this.groups = this.groups.map((g) =>
      g.id === groupId ? { ...g, name: name.trim() || DEFAULT_GROUP_NAME, updatedAt: Date.now() } : g,
    );
    this.persistGroups();
  }

  /** 改成员集合（网络按交集对齐重建；静音成员中被移除的自动清理）。 */
  setMembers(groupId: string, memberKeys: string[]): void {
    this.groups = this.groups.map((g) => {
      if (g.id !== groupId) return g;
      const keep = new Set(memberKeys);
      return {
        ...g,
        memberKeys: [...memberKeys],
        mutedKeys: g.mutedKeys.filter((k) => keep.has(k)),
        network: resizeNetwork(g.network, memberKeys),
        updatedAt: Date.now(),
      };
    });
    this.persistGroups();
  }

  /** 静音 / 取消静音某成员。 */
  toggleMute(groupId: string, memberKey: string): void {
    this.groups = this.groups.map((g) => {
      if (g.id !== groupId) return g;
      const muted = g.mutedKeys.includes(memberKey)
        ? g.mutedKeys.filter((k) => k !== memberKey)
        : [...g.mutedKeys, memberKey];
      return { ...g, mutedKeys: muted, updatedAt: Date.now() };
    });
    this.persistGroups();
  }

  /** 直接替换网络数据（关系/优先级/触发编辑走这里；Phase 1 只用默认值）。 */
  setNetwork(groupId: string, network: GroupNetwork): void {
    this.groups = this.groups.map((g) =>
      g.id === groupId ? { ...g, network: normalizeNetwork(network, g.memberKeys), updatedAt: Date.now() } : g,
    );
    this.persistGroups();
  }

  /** 删群（连带删掉它的会话）。 */
  remove(groupId: string): void {
    this.groups = this.groups.filter((g) => g.id !== groupId);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.groupId !== groupId);
    if (this.activeGroupId === groupId) this.activeGroupId = this.groups[0]?.id ?? null;
    this.persistGroups();
    if (before !== this.sessions.length) this.persistSessions();
    logger.info('groups', '已删群', { groupId });
  }

  setActive(groupId: string | null): void {
    this.activeGroupId = groupId;
    this.persistGroups();
  }

  // ── 群会话 ───────────────────────────────────────────────────────────────
  /** 某群的会话（按最近更新排序）。 */
  listForGroup(groupId: string): GroupSessionRecord[] {
    return this.sessions.filter((s) => s.groupId === groupId).sort(byGroupRecency);
  }

  /** 开一条群会话（已存在最近一条则复用）。 */
  openForGroup(groupId: string): GroupSessionRecord {
    const existing = this.listForGroup(groupId)[0];
    if (existing) return existing;
    return this.createSession(groupId);
  }

  createSession(groupId: string, title = UNTITLED_GROUP_SESSION): GroupSessionRecord {
    const now = Date.now();
    const rec: GroupSessionRecord = {
      v: GROUP_CODEC_VERSION,
      id: `gs_${now}_${Math.random().toString(36).slice(2, 8)}`,
      groupId,
      title,
      renamed: false,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    this.sessions = pruneGroupSessions([rec, ...this.sessions]);
    this.persistSessions();
    return rec;
  }

  /**
   * 追加一轮（**一轮 = 用户一次发送 + 该轮全部成员回复**）。
   * 标题在首轮按首条用户消息自动生成（用户手动改过则不再动）。
   */
  appendTurn(sessionId: string, turn: Omit<GroupTurn, 'id' | 'round'>): GroupSessionRecord | null {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) return null;
    const cur = this.sessions[idx];
    const full: GroupTurn = {
      ...turn,
      id: `gt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      round: cur.turns.length + 1,
    };
    const next: GroupSessionRecord = {
      ...cur,
      turns: pruneGroupTurns([...cur.turns, full]),
      title:
        !cur.renamed && cur.turns.length === 0 && turn.userText.trim()
          ? turn.userText.trim().slice(0, 24)
          : cur.title,
      updatedAt: Date.now(),
    };
    this.sessions = this.sessions.map((s) => (s.id === sessionId ? next : s));
    this.persistSessions();
    return next;
  }

  /** 用新的回复数组覆盖某轮（流式落定 / 重生成用）。 */
  replaceReplies(sessionId: string, turnId: string, replies: GroupReply[]): void {
    this.sessions = this.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            turns: s.turns.map((t) => (t.id === turnId ? { ...t, replies } : t)),
            updatedAt: Date.now(),
          }
        : s,
    );
    this.persistSessions();
  }

  renameSession(sessionId: string, title: string): void {
    this.sessions = this.sessions.map((s) =>
      s.id === sessionId ? { ...s, title: title.trim() || UNTITLED_GROUP_SESSION, renamed: true, updatedAt: Date.now() } : s,
    );
    this.persistSessions();
  }

  removeSession(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.persistSessions();
  }

  /** 统计（UI 展示「N 轮 · M 条发言」）。 */
  statsOf(rec: GroupSessionRecord): { turns: number; replies: number } {
    return { turns: countGroupTurns(rec), replies: countGroupReplies(rec) };
  }

  /** 清空全部群数据（调试/迁移用；不动单角色会话）。 */
  reset(): void {
    this.groups = [];
    this.activeGroupId = null;
    this.sessions = [];
    this.persistGroups();
    this.persistSessions();
  }
}

export const groups = new GroupsStore();
