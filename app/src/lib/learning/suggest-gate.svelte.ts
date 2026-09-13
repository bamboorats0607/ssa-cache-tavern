/**
 * 学习建议确认闸（响应式壳，spec T3.1 + T4.1）。// [SSA-LEARN]
 *
 * ── 本文件只做接线 ────────────────────────────────────────────────────────
 * 所有可判定逻辑在 `lib/learning/gate-core.ts` 与 `lib/learning/apply-core.ts`
 * （纯函数、Node 可直跑）；本壳只负责：响应式状态 · localStorage 读写 ·
 * 世界书写请求 · 按 flag 显隐 · 渲染数据整形。
 *
 * ── 硬约束 ────────────────────────────────────────────────────────────────
 * · C-06 / R-02：**无自动提交**。写世界书的唯一入口是 `apply()`（用户在确认闸里
 *   点了「采纳」），没有任何批量/自动/定时入口；本模块**不 import**
 *   任何组装/注入模块（`assembler` / `chat-context` / `memory` / 群网）——
 *   Phase 4 只新增 `stores/worldbook.svelte.ts`（落盘通道，C-07）。
 * · C-02 / R9：语料只读 `tavern.sessions`（单角色），**绝不**读群聊键。
 * · R-08：面板只显示建议标题/正文/来源，**不显示** θ、minFreq、window 等内核数值。
 * · T2.3：跑之前先按 `UI_WINDOW_CAP` 裁剪，且裁剪**必须显性告知**（R-11）。
 * · R-07：写出的条目 `position` 恒为 1（尾缀），绝不进前缀块（见 `apply-core`）。
 * · C-08：关 flag **不删除**已写进世界书的条目；撤销只能显式点「撤销」。
 */

import { isLearningEnabled, setLearningEnabled } from './learning-flag';
import {
  appliedEntriesOf,
  applyWindow,
  buildSuggestionList,
  decide,
  emptyLedger,
  gateView,
  LEDGER_KEY,
  loadLedger,
  pendingOf,
  saveLedger,
  TARGET_BOOK_KEY,
  tallyOf,
  targetOf,
  type DecisionAction,
  type GateRun,
  type GateView,
  type Ledger,
  type StorageLike,
  type SuggestionItem,
} from './gate-core';
import {
  DEFAULT_LEARNING_BOOK,
  isAppliable,
  learnedIdOf,
  mergeLearnedEntry,
  removeLearnedEntry,
  toWorldbookEntry,
} from './apply-core';
import { toCorpus } from './corpus';
import { UI_WINDOW_CAP, runProvisioning, type ProvisionSuggestions } from './provision/index.ts';
import { normalizeSessions, type ChatSession } from '../chat-sessions';
import { worldbook } from '../../stores/worldbook.svelte';
import type { WorldInfoEntry } from '../context/assembler';

const SESSIONS_KEY = 'tavern.sessions';

/** 浏览器存储；不可用时返回 null（隐私模式等），由 core 统一报错。 */
function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * 读单角色语料。
 *
 * **只读 `tavern.sessions`**：群聊记录在 `tavern.groupSessions` 独立键中，
 * 本函数不碰（spec C-02 / R9）。读取失败**抛出**，由调用方转成 `failed` 态
 * ——不得静默成「零建议」（R-11）。
 */
export function readLocalSessions(storage: StorageLike | null): ChatSession[] {
  if (!storage) throw new Error('本机存储不可用，读不到会话语料');
  const raw = storage.getItem(SESSIONS_KEY);
  if (!raw) return [];
  return normalizeSessions(JSON.parse(raw));
}

class LearningGate {
  /** flag 状态（视图据此显隐入口；C-13 回滚：关 flag → UI 入口隐藏） */
  enabled = $state(false);
  /** 当前建议列表（跑完才有） */
  items = $state<SuggestionItem[]>([]);
  /** 采纳台账 */
  ledger = $state<Ledger>(emptyLedger());
  /** 运行态 */
  run = $state<GateRun>({ status: 'idle' });
  /** 显性提示（裁剪告知 / 存储失败 / 台账损坏）；null = 无 */
  notice = $state<string | null>(null);
  /** 最近一次学习的来源统计（用于面板脚注，非内核数值） */
  lastRunInfo = $state<{ sessions: number; turns: number; messages: number; droppedEmpty: number } | null>(null);
  /** 落盘目标世界书名（Phase 4；null = 尚未选择，此时「采纳」只提示不写） */
  targetBook = $state<string | null>(null);
  /** 落盘请求进行中（UI 禁用按钮，避免重复写） */
  writing = $state(false);

  /** 用户可读状态（空态 / 降态 / 失败态由 core 区分，R-11） */
  view = $derived<GateView>(gateView(this.run, this.ledger));
  /** 台账计数（applied / edited / rejected / reverted） */
  tally = $derived(tallyOf(this.ledger));
  /** 待处理条目（列表只渲染这些：处理过的即离场，反馈明确） */
  pendingItems = $derived(pendingOf(this.items, this.ledger));
  /** 当前**仍在世界书里**的学习条目（撤销入口的数据源） */
  applied = $derived(appliedEntriesOf(this.ledger));

  constructor() {
    this.enabled = isLearningEnabled();
    const { ledger, error } = loadLedger(storageOrNull());
    this.ledger = ledger;
    if (error) this.notice = error;
    try {
      const b = storageOrNull()?.getItem(TARGET_BOOK_KEY);
      if (b) this.targetBook = b;
    } catch {
      /* 静默：选不到目标书时「采纳」会显性提示，不在这里报错 */
    }
  }

  setEnabled(on: boolean): void {
    setLearningEnabled(on);
    this.enabled = on;
    if (!on) {
      // C-08：关 flag **不删除**已采纳台账、也**不删除**已写进世界书的条目。
      // 这里显式说明，避免被误读成「复原」。
      this.notice = this.ledger.decisions.length
        ? '学习入口已隐藏；已采纳的台账与已写入世界书的条目都保留（关开关不会自动删除）。'
        : null;
      this.run = { status: 'idle' };
      this.items = [];
    }
  }

  /** 选定落盘目标世界书（只记名字；正文由后端世界书接口管）。 */
  setTargetBook(name: string | null): void {
    this.targetBook = name;
    try {
      const s = storageOrNull();
      if (!s) return;
      if (name) s.setItem(TARGET_BOOK_KEY, name);
      else s.removeItem(TARGET_BOOK_KEY);
    } catch (e) {
      this.notice = `目标世界书选择未能保存：${String(e)}`;
    }
  }

  /** 新建专用世界书并选为落盘目标（避免往用户的既有书里塞东西）。 */
  async createTargetBook(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      const ok = await worldbook.create(DEFAULT_LEARNING_BOOK);
      if (!ok) {
        this.notice = worldbook.lastWriteError || '新建世界书失败（原因未知）';
        return;
      }
      this.setTargetBook(DEFAULT_LEARNING_BOOK);
      this.notice = `已新建世界书《${DEFAULT_LEARNING_BOOK}》并设为落盘目标。`;
    } finally {
      this.writing = false;
    }
  }

  /** 跑一次学习（**唯一触发方式：用户点按钮**；不做会话结束自动触发）。 */
  async start(): Promise<void> {
    this.notice = null;
    this.run = { status: 'running' };
    // 让「学习中」先渲染一帧，再进同步计算（T2.3：管线是同步的，会占住主线程）
    await new Promise((r) => setTimeout(r, 0));
    try {
      const sessions = readLocalSessions(storageOrNull());
      const corpus = toCorpus(sessions);
      const windowed = applyWindow(corpus.messages, UI_WINDOW_CAP);

      const provisions: ProvisionSuggestions = runProvisioning(windowed.messages, {
        generatedAt: new Date().toISOString(),
      });
      const items = buildSuggestionList(provisions);

      this.items = items;
      this.lastRunInfo = {
        sessions: corpus.meta.sessions,
        turns: corpus.meta.turns,
        messages: windowed.messages.length,
        droppedEmpty: corpus.meta.droppedEmpty,
      };
      // R-11：裁剪与语料卫生**显性告知**，不静默。语料侧文案由 corpus.ts 单一维护点给出。
      const notes: string[] = [];
      if (windowed.truncated) {
        notes.push(`语料较多，本次只学习了最近 ${UI_WINDOW_CAP} 条（共 ${windowed.total} 条）`);
      }
      notes.push(...corpus.meta.warnings);
      this.notice = notes.length ? notes.join('；') : null;
      this.run = { status: 'done', items };
    } catch (e) {
      this.run = { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 采纳某条：**写进目标世界书**，成功才记台账（Phase 4 / C-07）。
   *
   * 与 B' 阶段的区别：那时「采纳」只进台账；现在它是真的落盘动作，
   * 所以任何失败都必须**显性**（R8），且**不得**留下 applied 记录（不虚报成功）。
   * 观测性产物（场景/耦合/归并）没有可注入正文 → 只有提示，**不记采纳**
   * （否则「已采纳 N 条」与实际写入数不符）。
   */
  async apply(uid: string, text: string): Promise<void> {
    await this.writeAndCommit(uid, text, 'applied');
  }

  /** 拒绝某条（纯本地记录，不碰世界书）。 */
  reject(uid: string, text: string): void {
    this.commit(uid, 'rejected', text);
  }

  /** 编辑后采纳某条（把编辑后的正文写进世界书）。 */
  async edit(uid: string, text: string): Promise<void> {
    await this.writeAndCommit(uid, text, 'edited');
  }

  /**
   * 落盘 + 记账的**唯一通道**。
   *
   * 已落盘过的 uid 再次写入时，**沿用台账里记的那本书**（而不是当前选择）——
   * 否则用户中途换目标书，会把条目写进新书、旧书里却留下孤儿副本。
   * 失败一律早退且不记账；成功才 `commit`（带 target，供撤销）。
   */
  private async writeAndCommit(
    uid: string,
    text: string,
    action: 'applied' | 'edited',
  ): Promise<void> {
    const item = this.items.find((i) => i.uid === uid);
    if (!item) {
      this.notice = '找不到这条建议（建议列表已刷新？），请重新学习后再试。';
      return;
    }
    if (!isAppliable(item.kind)) {
      this.notice = `「${item.title}」是参考信息（没有可注入正文），不进世界书 —— 不需要采纳。`;
      return;
    }
    const prev = targetOf(this.ledger, uid);
    const book = prev?.book ?? this.targetBook;
    if (!book) {
      this.notice = '请先选择（或新建）要写入的世界书，再点采纳。';
      return;
    }
    if (this.writing) return;

    const now = new Date().toISOString();
    const entry = toWorldbookEntry(
      {
        uid,
        title: item.title,
        keys: item.keys ?? [],
        content: text,
        kind: item.kind === 'cluster' ? 'cluster' : 'template',
      },
      now,
    );
    if (!entry) {
      this.notice = '这条建议没有可写入的触发词或正文，未写入世界书。';
      return;
    }

    this.writing = true;
    try {
      const existing = await this.readBookEntries(book);
      if (existing === null) return; // 读失败已提示；**绝不**在未知现状上写
      if (!(await this.writeBookEntries(book, mergeLearnedEntry(existing, entry)))) return;
      this.commit(uid, action, text, { book, learnedId: learnedIdOf(uid) });
      this.notice = `已写入世界书《${book}》：${item.title.slice(0, 40)}（可在本页撤销）`;
    } finally {
      this.writing = false;
    }
  }

  /**
   * 撤销某条：从世界书里**摘除**该条目，成功才记 `reverted`（M3 / C-08）。
   * 与「关 flag」无关 —— 关 flag 不会删任何已写条目（C-08 明确无此宣称）。
   */
  async revert(uid: string): Promise<void> {
    const target = targetOf(this.ledger, uid);
    if (!target) {
      // 没落盘过（理论不该出现）：直接记为撤销，保持语义一致
      this.commit(uid, 'reverted', '');
      return;
    }
    if (this.writing) return;
    this.writing = true;
    try {
      const existing = await this.readBookEntries(target.book);
      if (existing === null) return;
      const { entries, removed } = removeLearnedEntry(existing, target.learnedId);
      if (!removed) {
        // 书里已无此条（被用户在世界书页手动删了）→ 台账仍要如实更新，并说明
        this.commit(uid, 'reverted', '');
        this.notice = `《${target.book}》里已找不到这条内容（可能被手动删过），已只更新本机记录。`;
        return;
      }
      if (!(await this.writeBookEntries(target.book, entries))) return;
      this.commit(uid, 'reverted', '');
      this.notice = `已从《${target.book}》移除该条目。`;
    } finally {
      this.writing = false;
    }
  }

  /** 读某本世界书的条目；**失败返回 null**（并把原因写进 notice）——不得当成空书。 */
  private async readBookEntries(book: string): Promise<WorldInfoEntry[] | null> {
    // 重置上一次的写错误，才能区分「这本书本来就是空的」与「这次没读到」
    worldbook.lastWriteError = null;
    const entries = await worldbook.readEntries(book);
    if (worldbook.lastWriteError) {
      this.notice = `读不到世界书《${book}》：${worldbook.lastWriteError}（未做任何写入）`;
      return null;
    }
    return entries;
  }

  /** 写整本世界书；失败返回 false（原因已进 notice）。 */
  private async writeBookEntries(book: string, entries: WorldInfoEntry[]): Promise<boolean> {
    const ok = await worldbook.saveEntries(book, entries);
    if (!ok) {
      this.notice = `写入世界书《${book}》失败：${worldbook.lastWriteError || '原因未知'}（本机记录未变更）`;
      return false;
    }
    return true;
  }

  private commit(
    uid: string,
    action: DecisionAction,
    text: string,
    target?: { book: string; learnedId: string },
  ): void {
    const next = decide(this.ledger, uid, action, text, new Date().toISOString(), target);
    const err = saveLedger(storageOrNull(), next);
    if (err) {
      // R8：写失败必须显性，且**不**把内存态当成已保存
      this.notice = err;
      return;
    }
    this.ledger = next;
  }

  /** 清空台账（显式动作，供用户自行重置；**不影响**已写进世界书的条目）。 */
  clearLedger(): void {
    const err = saveLedger(storageOrNull(), emptyLedger());
    if (err) {
      this.notice = err;
      return;
    }
    this.ledger = emptyLedger();
    this.notice = '已清空学习台账（仅清本机采纳记录；**已写入世界书的条目不会被删除**，需要请在世界书页删除）。';
  }
}

export const learningGate = new LearningGate();
export { LEDGER_KEY };
