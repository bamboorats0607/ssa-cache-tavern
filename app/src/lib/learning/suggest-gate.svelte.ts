/**
 * 学习副本沙盒（响应式壳）。// [SSA-LEARN]
 *
 * ── 本文件只做接线 ────────────────────────────────────────────────────────
 * 所有可判定逻辑在三个纯模块里（Node 可直跑，门禁直接 import 生产代码）：
 *   · `gate-core.ts`  —— 建议列表 / 台账 / 存储 / 状态机
 *   · `copy-core.ts`  —— 沙盒内核：原样克隆 / 只增不改 / 双不变量 / 配额 / 增量视图
 *   · `corpus.ts`     —— 语料映射与**角色限定**（C-02 单一维护点）
 * 本壳只负责：响应式状态 · localStorage 读写 · 世界书写请求 · 按 flag 显隐。
 *
 * ── 红线（2026-09-13 裁定 §10；C-06 / R-02 / R-11）─────────────────────────
 * · **写入范围 ⊆ {学习副本}**：唯一写入口 `writeToCopy()` 先断言沙盒存在且副本
 *   正是激活书，否则**拒写**。唯一例外是「撤销历史遗留条目」——那是**摘除**
 *   （不可能注入内容），且 id 必须来自台账（见 `revert()` 注释）。
 * · **原书自克隆起不进写入路径**：源书只在 `enableSandbox()` 里被**读**一次。
 * · **只增不改**：写入前跑 `invariantReport`，任一不变量被破坏就**不发起请求**
 *   （fail-closed）。同 `learnedId` 已存在 = no-op 跳过（P1：无合并、无覆盖）。
 * · **配额是唯一刹车**：`planRound()` 在写入侧筛；配额满进入**显性暂停**（禁静默丢弃）。
 * · **关 flag 不删条目、不切书**（C-08）；切回 / 删副本都是显式动作。
 * · 本模块**不 import** 任何组装/注入模块（`assembler` / `chat-context` / `memory` / 群网）。
 */

import { isLearningEnabled, setLearningEnabled } from './learning-flag';
import {
  applyWindow,
  buildSuggestionList,
  decide,
  emptyLedger,
  gateView,
  loadLedger,
  loadSandbox,
  pendingOf,
  SANDBOX_KEY,
  saveLedger,
  saveSandbox,
  tallyOf,
  targetsOf,
  type DecisionAction,
  type GateRun,
  type GateView,
  type Ledger,
  type SandboxRecord,
  type StorageLike,
  type SuggestionItem,
} from './gate-core';
import {
  appendLearned,
  contentLearnedId,
  copyNameFor,
  deltaVsSnapshot,
  digestOf,
  invariantReport,
  isAppliable,
  planRound,
  quotaStatusOf,
  rawCloneOf,
  removeAllLearned,
  removeLearnedIds,
  stampOf,
  writesAllowed,
  type AppliableKind,
  type CopyDelta,
  type LearnedDraft,
  type QuotaStatus,
} from './copy-core';
import { readLocalSessions, scopeToCharacter, toCorpus } from './corpus';
import { UI_WINDOW_CAP, runProvisioning, type ProvisionSuggestions } from './provision/index.ts';
import { worldbook } from '../../stores/worldbook.svelte';
import { sessions } from '../../stores/sessions.svelte';

/** 浏览器存储；不可用时返回 null（隐私模式等），由 core 统一报错。 */
function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 副本的实时状态（读一次后端得到的值，供面板显示；可观测项之一）。 */
export interface CopyState {
  counts: { cluster: number; template: number };
  quota: QuotaStatus;
  delta: CopyDelta;
  /** 副本里学习条目总数 */
  learnedTotal: number;
  /** 读回失败原因（null = 正常） */
  error: string | null;
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
  /** 显性提示（裁剪告知 / 存储失败 / 台账损坏 / 写入结果）；null = 无 */
  notice = $state<string | null>(null);
  /** 最近一次学习的来源统计（面板脚注；含**角色限定**结果） */
  lastRunInfo = $state<{
    sessions: number;
    turns: number;
    messages: number;
    droppedEmpty: number;
    /** 语料限定的角色名（null = 未限定：当时没有活动会话） */
    character: string | null;
    /** 本机全部会话数（说明「只学了其中一部分」） */
    allSessions: number;
  } | null>(null);
  /** 沙盒记录（副本名 / 源书 / 克隆快照摘要）；null = 未启用副本沙盒 */
  sandbox = $state<SandboxRecord | null>(null);
  /** 副本实时状态（配额 / 增量视图 / 学习条目数） */
  copyState = $state<CopyState | null>(null);
  /** 落盘请求进行中（UI 禁用按钮，避免重复写） */
  writing = $state(false);

  /** 用户可读状态（空态 / 降态 / 失败态由 core 区分，R-11） */
  view = $derived<GateView>(gateView(this.run, this.ledger));
  /** 台账计数（applied / edited / rejected / reverted） */
  tally = $derived(tallyOf(this.ledger));
  /** 待处理条目（列表只渲染这些：处理过的即离场，反馈明确） */
  pendingItems = $derived(pendingOf(this.items, this.ledger));
  /** 当前**仍在世界书里**的学习条目（撤销入口的数据源） */
  applied = $derived(
    ((): { uid: string; text: string; at: string | null; target: { book: string; learnedId: string } }[] => {
      const seen = new Set<string>();
      const out: { uid: string; text: string; at: string | null; target: { book: string; learnedId: string } }[] = [];
      for (let i = this.ledger.decisions.length - 1; i >= 0; i--) {
        const d = this.ledger.decisions[i];
        if (seen.has(d.uid)) continue;
        seen.add(d.uid);
        if ((d.action === 'applied' || d.action === 'edited') && d.target) {
          out.push({ uid: d.uid, text: d.text, at: d.at, target: d.target });
        }
      }
      return out;
    })(),
  );
  /** 副本是否**正是当前激活的书**（不是则静默写入会写进不被注入的书 → 拒写） */
  copyActive = $derived(this.sandbox !== null && worldbook.activeName === this.sandbox.copyName);
  /** 副本相对克隆快照的增量视图 */
  delta = $derived<CopyDelta | null>(this.copyState?.delta ?? null);
  /** 配额状态（含显性暂停） */
  quota = $derived<QuotaStatus | null>(this.copyState?.quota ?? null);

  constructor() {
    this.enabled = isLearningEnabled();
    const { ledger, error } = loadLedger(storageOrNull());
    this.ledger = ledger;
    const sb = loadSandbox(storageOrNull());
    this.sandbox = sb.sandbox;
    const first = error ?? sb.error;
    if (first) this.notice = first;
    if (this.sandbox) void this.refreshCopyState();
  }

  setEnabled(on: boolean): void {
    setLearningEnabled(on);
    this.enabled = on;
    if (!on) {
      // C-08：关 flag **不删除**已采纳台账、也**不删除**已写进副本的条目、**不切书**。
      this.notice = this.ledger.decisions.length
        ? '学习入口已隐藏；副本、台账与已写入的条目都保留（关开关不会自动删除，也不会切回原书）。'
        : null;
      this.run = { status: 'idle' };
      this.items = [];
    }
  }

  // -------------------------------------------------------------------------
  // 沙盒生命周期（启用 = 一次性显式确认：创建副本 + 启用副本）
  // -------------------------------------------------------------------------

  /**
   * 启用沙盒：把**当前激活的世界书**克隆成副本，然后启用副本。
   *
   * 事务化（P3）：任一步失败都保持原书激活并显性报错；副本已建则不重复创建。
   * 写入**从不**发生在源书上。
   */
  async enableSandbox(): Promise<void> {
    if (this.writing) return;
    if (this.sandbox) {
      this.notice = `学习副本已存在：《${this.sandbox.copyName}》（源书《${this.sandbox.sourceName}》）。`;
      return;
    }
    const source = worldbook.activeName;
    if (!source) {
      this.notice = '请先在「设置 → 世界书」里启用一本世界书：学习会为它创建一个副本，产物只写副本。';
      return;
    }

    this.writing = true;
    this.notice = null;
    try {
      const raw = await worldbook.readRawBook(source);
      if (raw.book === null) {
        this.notice = `读不到源书《${source}》：${raw.error ?? '原因未知'}（未创建副本）。`;
        return;
      }
      const copyName = copyNameFor(
        source,
        stampOf(new Date()),
        worldbook.list.map((w) => w.name),
      );
      const clone = rawCloneOf(raw.book, copyName);
      if (clone === null) {
        this.notice = `源书《${source}》的 entries 形态不支持克隆（未创建副本）。`;
        return;
      }
      const created = await worldbook.saveRawBook(copyName, clone);
      if (!created.ok) {
        this.notice = `副本创建失败：${created.error ?? '原因未知'}（原书未受影响）。`;
        return;
      }
      const rec: SandboxRecord = {
        v: 1,
        copyName,
        sourceName: source,
        clonedAt: new Date().toISOString(),
        digest: digestOf(clone),
      };
      const err = saveSandbox(storageOrNull(), rec);
      if (err) {
        this.notice = `${err}（副本《${copyName}》已创建，但本机记录未保存）`;
        return;
      }
      this.sandbox = rec;

      const activated = await worldbook.activate(copyName, { source });
      if (!activated.ok) {
        // 事务化的关键：激活失败 → 原书仍是激活书；副本保留、标「未启用」，可重试
        this.notice =
          `副本《${copyName}》已创建，但启用失败：${activated.error ?? '原因未知'}；` +
          `已保持《${source}》激活。可在本页点「启用副本」重试。`;
        await this.refreshCopyState();
        return;
      }
      await this.refreshCopyState();
      this.notice = `已创建并启用学习副本《${copyName}》（源书《${source}》自克隆起不进写入路径）。`;
    } finally {
      this.writing = false;
    }
  }

  /** 启用已建但未激活的副本（激活失败后的重试；不新建副本）。 */
  async activateCopy(): Promise<void> {
    const sb = this.sandbox;
    if (!sb) {
      this.notice = '还没有学习副本，请先点「创建并启用副本」。';
      return;
    }
    const r = await worldbook.activate(sb.copyName, { source: sb.sourceName });
    this.notice = r.ok
      ? `已启用学习副本《${sb.copyName}》。`
      : `启用副本失败：${r.error ?? '原因未知'}（已保持《${worldbook.activeName ?? '（无）'}》）。`;
    await this.refreshCopyState();
  }

  /** 显式切回源书（**不是**关 flag 的副作用；关 flag 不切书）。 */
  async switchBackToSource(): Promise<void> {
    const sb = this.sandbox;
    if (!sb) return;
    const r = await worldbook.activate(sb.sourceName, { source: null });
    this.notice = r.ok
      ? `已切回源书《${sb.sourceName}》；副本《${sb.copyName}》与其内容都还在。`
      : `切回源书失败：${r.error ?? '原因未知'}。`;
    await this.refreshCopyState();
  }

  /**
   * 删除副本（显式动作）。**先**切回源书再删，避免「激活书被删」的中间态；
   * 删完清掉沙盒记录（下次启用会新建副本）。
   */
  async deleteCopy(): Promise<void> {
    const sb = this.sandbox;
    if (!sb) return;
    if (worldbook.activeName === sb.copyName) {
      const back = await worldbook.activate(sb.sourceName, { source: null });
      if (!back.ok) {
        this.notice = `先切回源书失败：${back.error ?? '原因未知'}（未删除副本）。`;
        return;
      }
    }
    const ok = await worldbook.remove(sb.copyName);
    if (!ok) {
      this.notice = `删除副本失败：${worldbook.lastWriteError ?? '原因未知'}。`;
      return;
    }
    const err = saveSandbox(storageOrNull(), null);
    this.sandbox = null;
    this.copyState = null;
    this.notice = err
      ? `${err}（副本《${sb.copyName}》已删除）`
      : `已删除副本《${sb.copyName}》并切回源书《${sb.sourceName}》。`;
  }

  /** 读回副本并刷新状态（配额 / 增量视图 / 学习条目数）。 */
  async refreshCopyState(): Promise<void> {
    const sb = this.sandbox;
    if (!sb) {
      this.copyState = null;
      return;
    }
    const raw = await worldbook.readRawBook(sb.copyName);
    if (raw.book === null) {
      const quota = quotaStatusOf(null);
      this.copyState = {
        counts: { cluster: quota.cluster, template: quota.template },
        quota,
        delta: deltaVsSnapshot(sb.digest, null),
        learnedTotal: 0,
        error: raw.error ?? '读不到副本',
      };
      return;
    }
    const quota = quotaStatusOf(raw.book);
    this.copyState = {
      counts: { cluster: quota.cluster, template: quota.template },
      quota,
      delta: deltaVsSnapshot(sb.digest, raw.book),
      learnedTotal: quota.cluster + quota.template,
      error: null,
    };
  }

  // -------------------------------------------------------------------------
  // 学习运行（手动按钮；静默触发走 `lib/learning/silent-trigger.ts`）
  // -------------------------------------------------------------------------

  /**
   * 跑一次学习（**手动**入口）。
   *
   * P7 / LG-15：语料限**当前活动会话所属角色**——不限定会跨角色污染
   * （角色 A 的簇里混进角色 B 的专名）。没有活动会话时才退回全部会话，并显性说明。
   */
  async start(): Promise<void> {
    this.notice = null;
    this.run = { status: 'running' };
    // 让「学习中」先渲染一帧，再进同步计算（T2.3：管线是同步的，会占住主线程）
    await new Promise((r) => setTimeout(r, 0));
    try {
      const all = readLocalSessions(storageOrNull());
      const scope = scopeToCharacter(all, sessions.active?.characterName ?? null);
      const corpus = toCorpus(scope.sessions);
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
        character: scope.character,
        allSessions: all.length,
      };
      const notes: string[] = [];
      notes.push(scope.note);
      if (windowed.truncated) {
        notes.push(`语料较多，本次只学习了最近 ${UI_WINDOW_CAP} 条（共 ${windowed.total} 条）`);
      }
      notes.push(...corpus.meta.warnings);
      this.notice = notes.join('；');
      this.run = { status: 'done', items };
    } catch (e) {
      this.run = { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  // -------------------------------------------------------------------------
  // 落盘（唯一写入通道：副本 + 原样追加 + 双不变量 + 配额）
  // -------------------------------------------------------------------------

  /** 采纳某条：**写进学习副本**，成功才记台账。 */
  async apply(uid: string, text: string): Promise<void> {
    await this.adopt(uid, text, 'applied');
  }

  /** 编辑后采纳某条（编辑后的正文写进副本；旧条目按「只增不改」保留）。 */
  async edit(uid: string, text: string): Promise<void> {
    await this.adopt(uid, text, 'edited');
  }

  /** 拒绝某条（纯本地记录，不碰世界书）。 */
  reject(uid: string, text: string): void {
    this.commit(uid, 'rejected', text);
  }

  private async adopt(uid: string, text: string, action: 'applied' | 'edited'): Promise<void> {
    const item = this.items.find((i) => i.uid === uid);
    if (!item) {
      this.notice = '找不到这条建议（建议列表已刷新？），请重新学习后再试。';
      return;
    }
    if (!isAppliable(item.kind)) {
      this.notice = `「${item.title}」是参考信息（没有可注入正文），不进世界书 —— 不需要采纳。`;
      return;
    }
    const draft: LearnedDraft = {
      uid,
      title: item.title,
      keys: item.keys ?? [],
      content: text,
      kind: item.kind,
    };
    await this.writeToCopy([draft], action, uid, text, `「${item.title.slice(0, 40)}」`);
  }

  /**
   * 写入副本（**唯一**写入口）。
   *
   * 顺序（每步失败即早退，绝不在未知现状上写）：
   * ① 写许可（`writesAllowed`：有沙盒 && 副本≠源书 && 副本**正是激活书**）
   * → ② 读回副本原始 JSON → ③ 配额筛（`planRound`）
   * → ④ 原样追加（`appendLearned`）→ ⑤ 不变量断言（`invariantReport`）
   * → ⑥ 原样写回（`saveRawBook`）→ ⑦ 记账 + 刷新状态。
   */
  private async writeToCopy(
    drafts: LearnedDraft[],
    action: DecisionAction,
    uid: string,
    text: string,
    label: string,
  ): Promise<void> {
    const sb = this.sandbox;
    // 写许可由纯函数判定（`writesAllowed`）：无沙盒 / 副本名=源书名 / 副本非激活书 → 一律拒写
    const guard = writesAllowed(sb, worldbook.activeName);
    if (!guard.ok || !sb) {
      this.notice = guard.reason;
      return;
    }
    if (this.writing) return;

    this.writing = true;
    try {
      const raw = await worldbook.readRawBook(sb.copyName);
      if (raw.book === null) {
        this.notice = `读不到副本《${sb.copyName}》：${raw.error ?? '原因未知'}（未做任何写入）。`;
        return;
      }
      const plan = planRound(raw.book, drafts);
      if (plan.accepted.length === 0) {
        if (plan.skip.duplicate > 0) {
          this.notice = `${label}的内容已在副本里（内容派生标识相同）—— 未重复写入。`;
        } else if (plan.skip.quotaFull > 0) {
          this.notice = `${plan.status.reason ?? '配额已满'} —— ${label}未写入（不会静默丢弃）。`;
        } else {
          this.notice = `${label}没有可写入的触发词或正文，未写入世界书。`;
        }
        await this.refreshCopyState();
        return;
      }

      const now = new Date().toISOString();
      const app = appendLearned(raw.book, plan.accepted, now);
      if (app.book === null) {
        this.notice = `副本《${sb.copyName}》的 entries 形态不合法，已拒绝写入。`;
        return;
      }
      const violations = invariantReport(raw.book, app.book, { mode: 'append' });
      if (violations.length > 0) {
        this.notice = `写入被拒绝（会破坏「只增不改」）：${violations[0].detail}`;
        return;
      }
      const saved = await worldbook.saveRawBook(sb.copyName, app.book);
      if (!saved.ok) {
        this.notice = `写入副本失败：${saved.error ?? '原因未知'}（本机记录未变更）。`;
        return;
      }

      const written = app.appended[0];
      this.commit(uid, action, text, { book: sb.copyName, learnedId: written.learnedId });
      const skipped = plan.skip.total() > 0 ? `；本轮另有 ${plan.skip.total()} 条因配额/重复未写` : '';
      this.notice = `已写入副本《${sb.copyName}》：${label}（可在本页撤销）${skipped}`;
      await this.refreshCopyState();
    } finally {
      this.writing = false;
    }
  }

  /**
   * 撤销某条：从**它落盘时的那本书**里摘除该 uid 的全部学习条目，成功才记 `reverted`。
   *
   * 唯一允许写非副本的情形：摘除**历史遗留**条目（台账里记着 id 的学习产物）。
   * 那是「清理自己过去的产物」，**不可能**把内容注入任何书，故不违反
   * 「禁止向非副本提交」；新写入路径永远只能落在副本上。
   */
  async revert(uid: string): Promise<void> {
    const targets = targetsOf(this.ledger, uid);
    if (targets.length === 0) {
      this.commit(uid, 'reverted', '');
      return;
    }
    if (this.writing) return;
    this.writing = true;
    try {
      const byBook = new Map<string, string[]>();
      for (const t of targets) {
        const list = byBook.get(t.book) ?? [];
        list.push(t.learnedId);
        byBook.set(t.book, list);
      }
      let removedTotal = 0;
      const gone: string[] = [];
      for (const [book, ids] of byBook) {
        const raw = await worldbook.readRawBook(book);
        if (raw.book === null) {
          this.notice = `读不到世界书《${book}》：${raw.error ?? '原因未知'}（未做任何变更）。`;
          return;
        }
        const res = removeLearnedIds(raw.book, ids);
        if (res.book === null) {
          this.notice = `《${book}》的 entries 形态不合法，已拒绝写入。`;
          return;
        }
        if (res.removed === 0) {
          gone.push(book);
          continue;
        }
        const violations = invariantReport(raw.book, res.book, { mode: 'revert', allowRemovedIds: ids });
        if (violations.length > 0) {
          this.notice = `撤销被拒绝（会破坏不变量）：${violations[0].detail}`;
          return;
        }
        const saved = await worldbook.saveRawBook(book, res.book);
        if (!saved.ok) {
          this.notice = `写入世界书《${book}》失败：${saved.error ?? '原因未知'}（本机记录未变更）。`;
          return;
        }
        removedTotal += res.removed;
      }
      this.commit(uid, 'reverted', '');
      this.notice = removedTotal
        ? `已从《${[...byBook.keys()].join('》《')}》移除 ${removedTotal} 条学习条目。`
        : `《${gone.join('》《')}》里已找不到这条内容（可能被手动删过），已只更新本机记录。`;
      await this.refreshCopyState();
    } finally {
      this.writing = false;
    }
  }

  /**
   * 一键整体回滚：摘除副本里**全部**学习条目（用户手改过的条目不参与回滚），
   * 并把台账里对应的 uid 记为 `reverted`（不留「还在书里」的假象）。
   */
  async rollbackAll(): Promise<void> {
    const sb = this.sandbox;
    if (!sb) {
      this.notice = '还没有学习副本，无需回滚。';
      return;
    }
    if (this.writing) return;
    this.writing = true;
    try {
      const raw = await worldbook.readRawBook(sb.copyName);
      if (raw.book === null) {
        this.notice = `读不到副本《${sb.copyName}》：${raw.error ?? '原因未知'}（未做任何变更）。`;
        return;
      }
      const res = removeAllLearned(raw.book);
      if (res.book === null) {
        this.notice = `副本《${sb.copyName}》的 entries 形态不合法，已拒绝写入。`;
        return;
      }
      if (res.removed === 0) {
        this.notice = `副本《${sb.copyName}》里没有学习条目，无需回滚。`;
        await this.refreshCopyState();
        return;
      }
      // 整体回滚就是要摘掉**全部**学习条目 ⇒ 「学习条目仍在」这一条不适用；
      // 只保留 ① 非学习条目冻结 的检查（用户手改的条目绝不能被回滚动到）。
      const blocking = invariantReport(raw.book, res.book, { mode: 'revert', allowRemovedIds: [] }).filter(
        (v) => v.code === 'nonLearnedChanged' || v.code === 'notMutable',
      );
      if (blocking.length > 0) {
        this.notice = `回滚被拒绝（会破坏非学习条目冻结）：${blocking[0].detail}`;
        return;
      }
      const saved = await worldbook.saveRawBook(sb.copyName, res.book);
      if (!saved.ok) {
        this.notice = `回滚写入失败：${saved.error ?? '原因未知'}（本机记录未变更）。`;
        return;
      }
      // 台账：把这些 uid 记为 reverted（否则面板会继续显示「仍在世界书里」）
      const now = new Date().toISOString();
      const uids = new Set<string>();
      for (const d of this.ledger.decisions) {
        if (d.target?.book === sb.copyName) uids.add(d.uid);
      }
      let ledger: Ledger = this.ledger;
      for (const u of uids) ledger = decide(ledger, u, 'reverted', '', now);
      const err = saveLedger(storageOrNull(), ledger);
      if (err) {
        this.notice = `${err}（副本已回滚，但本机台账未更新）`;
      } else {
        this.ledger = ledger;
        this.notice = `已整体回滚：从副本《${sb.copyName}》摘除 ${res.removed} 条学习条目（你手改过的条目不参与回滚）。`;
      }
      await this.refreshCopyState();
    } finally {
      this.writing = false;
    }
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

  /** 清空台账（显式动作；**不影响**副本里的条目）。 */
  clearLedger(): void {
    const err = saveLedger(storageOrNull(), emptyLedger());
    if (err) {
      this.notice = err;
      return;
    }
    this.ledger = emptyLedger();
    this.notice = '已清空学习台账（仅清本机采纳记录；**副本里的条目不会被删除**，需要请点「整体回滚」）。';
  }
}

export const learningGate = new LearningGate();
export { SANDBOX_KEY, contentLearnedId };
export type { AppliableKind };
