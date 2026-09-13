/**
 * 对话（会话）store —— 响应式状态 + 持久化。
 *
 * ── 概念澄清（用户明确纠正）──────────────────────────────────────────────
 * 「会话」= **一个角色下的一条对话线**。例如角色「艾拉」可以有：
 *   艾拉 → 关于银线的追问
 *   艾拉 → 第一次见面
 * 用户可以切换、可以各自继续、可以新建、可以删除。
 *
 * 此前实现把它做成了「用量统计的分桶」——只有 token 数字、没有对话内容，
 * 也不能切换回去。那是理解错误，本模块按「角色 → 多条对话」重建。
 *
 * ── 分层 ──────────────────────────────────────────────────────────────────
 * 纯逻辑（淘汰 / 消息派生 / 载入归一化）在 `lib/chat-sessions.ts`，可被 Node
 * 直接测试；本模块只负责**响应式状态 + localStorage 持久化**（不可单测）。
 *
 * ── 关键设计：对话内容不重复存储 ──────────────────────────────────────────
 * turns 里已含 userText / assistantText / stats，恢复对话时由 turns 派生消息，
 * 不再单独存一份 messages。好处：聊天气泡与统计页共用同一份事实来源，永远一致。
 *
 * ── 容量 ──────────────────────────────────────────────────────────────────
 * 只有 localStorage（项目无 IndexedDB）。设双上限 + 淘汰最旧：宁可丢最旧，
 * 也不要因配额耗尽导致**整个键写入失败**（那会连带丢掉新数据）。
 *
 * ── 角色标识的已知局限 ────────────────────────────────────────────────────
 * 上游 `CharacterCard` 只有 `name`、无唯一 id，故以**角色名**作归属键。
 * 同名角色卡会归并到同一组对话 —— 这是上游数据模型的限制。
 */

import { logger } from '../lib/logger';
import {
  clearAssistantFrom,
  listFor,
  normalizeSessions,
  pruneSessions,
  pruneTurns,
  truncateFrom,
  UNTITLED,
  type ChatSession,
  type StoredTurn,
} from '../lib/chat-sessions';

const KEY = 'tavern.sessions';

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

class SessionStore {
  /** 全部对话（按 updatedAt 倒序，最新在前） */
  list = $state<ChatSession[]>([]);
  /** 当前打开的对话 id */
  activeId = $state<string | null>(null);

  constructor() {
    this.list = pruneSessions(this.loadFromDisk());
    // 恢复上次打开的对话：优先用持久化记录的 activeId，否则取最新一条
    const remembered = this.loadActiveId();
    this.activeId =
      remembered && this.list.some((s) => s.id === remembered)
        ? remembered
        : (this.list[0]?.id ?? null);
  }

  private loadFromDisk(): ChatSession[] {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      return normalizeSessions(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  private loadActiveId(): string | null {
    try {
      return localStorage.getItem(`${KEY}.active`);
    } catch {
      return null;
    }
  }

  /** 当前打开的对话。 */
  get active(): ChatSession | null {
    return this.list.find((s) => s.id === this.activeId) ?? null;
  }

  /** 某角色的全部对话（最新在前）。 */
  listFor(characterName: string): ChatSession[] {
    return listFor(this.list, characterName);
  }

  /**
   * 打开某角色的对话：
   *  · 当前已打开的对话就属于该角色 → 保持不变（不打断正在进行的对话）
   *  · 否则打开该角色**最近**的一条
   *  · 该角色还没有任何对话 → 新建一条
   */
  openFor(characterName: string): ChatSession {
    const cur = this.active;
    if (cur && cur.characterName === characterName) return cur;

    const existing = this.listFor(characterName);
    if (existing.length > 0) {
      // 优先复用该角色最近的**空对话**（0 轮）。
      //
      // 反面教训（2026-09-12 实测）：若直接取 existing[0]，当角色只有一条空对话时
      // 也会走「打开最近」分支；但若这里改成"每次都新建"，则 `$effect` 在角色就绪时
      // 建的空对话会与实际发送时新建的对话并存 → 列表里累积幽灵「新对话」条目。
      // 复用空对话既避免幽灵条目，也符合用户直觉（还没聊的那条就是当前对话）。
      const empty = existing.find((s) => s.turns.length === 0);
      const target = empty ?? existing[0];
      this.setActive(target.id);
      logger.info('sessions', '打开角色对话', {
        character: characterName,
        title: target.title,
        reusedEmpty: !!empty,
      });
      return target;
    }
    return this.create(characterName);
  }

  /**
   * 一次性自愈：把归属为占位符的对话迁到真实角色名下。
   *
   * 背景：`ChatView.refresh()` 曾存在时序窗口 —— `service` 先于 `characters.load()`
   * 变 ready，窗口内发送会把会话写成 `characterName: '角色'`（占位符）。
   * 发送路径已修（见 ChatView.ensureCharacters），但**已落盘的孤儿对话里装着
   * 真实聊天记录**，`listFor(真实角色名)` 永远找不到它 → 用户看到「对话没保存」。
   * 此处按当前角色列表回填，让历史数据重新可见。
   *
   * 回填目标取列表首项：孤儿只在「没有任何角色可选」时产生，那一刻界面展示的
   * 就是 `list[0]`（`fallback` 在 active 为 null 时退化为 list[0]）。
   *
   * 幂等，重复调用无副作用；若角色列表真有名为「角色」的角色则不动作（防误伤）。
   *
   * @returns 迁移的对话条数（供日志/测试断言）
   */
  adoptOrphans(characterNames: string[]): number {
    const PLACEHOLDER = '角色';
    const target = characterNames[0];
    if (!target || characterNames.includes(PLACEHOLDER)) return 0;

    const n = this.list.filter((s) => s.characterName === PLACEHOLDER).length;
    if (n === 0) return 0;

    this.list = this.list.map((s) =>
      s.characterName === PLACEHOLDER ? { ...s, characterName: target } : s,
    );
    this.persist();
    logger.warn('sessions', '占位符对话已归位', { target, count: n });
    return n;
  }

  /** 显式新建一条对话并打开它。 */
  create(characterName: string): ChatSession {
    const session: ChatSession = {
      id: makeId(),
      characterName,
      title: UNTITLED,
      renamed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [],
    };
    this.list = pruneSessions([session, ...this.list]);
    this.setActive(session.id);
    this.persist();
    logger.info('sessions', '新建对话', { character: characterName, id: session.id });
    return session;
  }

  /** 切换到指定对话。 */
  switchTo(id: string): ChatSession | null {
    const target = this.list.find((s) => s.id === id);
    if (!target) return null;
    this.setActive(id);
    logger.info('sessions', '切换对话', { id, title: target.title });
    return target;
  }

  /** 追加一轮到当前打开的对话。 */
  appendTurn(turn: Omit<StoredTurn, 'round' | 'id'>) {
    const cur = this.active;
    if (!cur) return;

    const full: StoredTurn = { ...turn, id: makeId(), round: cur.turns.length + 1 };
    const turns = pruneTurns([...cur.turns, full]);

    // 自动标题：首条用户消息派生，仅在用户未手动重命名时生效。
    // 纯图片消息（无文字）也要给标题，否则整条对话永远停在「新对话」，无法辨认。
    const firstText = turn.userText.trim();
    const derived = firstText || ((turn.images?.length ?? 0) > 0 ? `[图片 ×${turn.images?.length}]` : '');
    const title = !cur.renamed && cur.turns.length === 0 && derived ? derived.slice(0, 24) : cur.title;

    const updated: ChatSession = { ...cur, turns, title, updatedAt: Date.now() };
    this.list = pruneSessions(this.list.map((s) => (s.id === cur.id ? updated : s)));
    this.persist();
  }

  /**
   * 撤销：删除指定轮次及其之后的所有轮次（对当前打开对话生效）。
   *
   * 标题保持原样：即使 turns 被清空也不回退到「新对话」——
   * 用户看到的标题是他进入这条对话时的锚点，截断后回退反而更难辨认。
   */
  truncateFrom(turnId: string): void {
    const cur = this.active;
    if (!cur) return;
    const turns = truncateFrom(cur.turns, turnId);
    if (turns === cur.turns) return; // 未命中：无变化，不必持久化
    this.replaceTurns(cur, turns);
    logger.info('sessions', '撤销消息及以下', { id: cur.id, turnId, left: turns.length });
  }

  /**
   * 撤销助手回复：清空指定轮次的 assistantText（保留其 userText），
   * 并删除其后所有轮次（对当前打开对话生效）。
   */
  clearAssistantFrom(turnId: string): void {
    const cur = this.active;
    if (!cur) return;
    const turns = clearAssistantFrom(cur.turns, turnId);
    if (turns === cur.turns) return; // 未命中：无变化，不必持久化
    this.replaceTurns(cur, turns);
    logger.info('sessions', '撤销助手回复及以下', { id: cur.id, turnId, left: turns.length });
  }

  /** 用新的 turns 覆盖指定对话（统一更新 updatedAt + 顺序淘汰 + 持久化）。 */
  private replaceTurns(cur: ChatSession, turns: StoredTurn[]) {
    const updated: ChatSession = { ...cur, turns, updatedAt: Date.now() };
    this.list = pruneSessions(this.list.map((s) => (s.id === cur.id ? updated : s)));
    this.persist();
  }

  /** 重命名对话（重命名后不再自动改标题）。 */
  rename(id: string, title: string) {
    const t = title.trim();
    if (!t) return;
    this.list = this.list.map((s) => (s.id === id ? { ...s, title: t, renamed: true } : s));
    this.persist();
  }

  /** 删除一条对话。 */
  remove(id: string) {
    this.list = this.list.filter((s) => s.id !== id);
    if (this.activeId === id) this.setActive(this.list[0]?.id ?? null);
    this.persist();
    logger.info('sessions', '删除对话', { id });
  }

  /** 清空全部对话。 */
  clear() {
    this.list = [];
    this.setActive(null);
    this.persist();
    logger.warn('sessions', '已清空全部对话记录');
  }

  private setActive(id: string | null) {
    this.activeId = id;
    try {
      if (id) localStorage.setItem(`${KEY}.active`, id);
      else localStorage.removeItem(`${KEY}.active`);
    } catch {
      /* 静默：activeId 丢失只影响下次启动的默认选中，不影响数据 */
    }
  }

  /**
   * 持久化。
   *
   * ⚠️ 配额耗尽时 `setItem` 会抛异常。静默吞掉会让用户以为已保存；
   * 向上冒泡会打断发送流程。此处捕获并记 warn，让问题在调试面板可见。
   */
  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.list));
    } catch (e) {
      logger.warn('sessions', '对话持久化失败（可能超出存储配额）', e);
    }
  }
}

export const sessions = new SessionStore();
