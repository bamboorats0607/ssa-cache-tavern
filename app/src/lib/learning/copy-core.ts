/**
 * 学习副本沙盒内核（**纯函数**，Node 可直跑）。// [SSA-LEARN]
 *
 * ── 为什么要有这一层（2026-09-13 裁定 §10 的落点）──────────────────────────
 * 学习产物不再「经确认闸逐条写进任选世界书」，而是**静默追加进 App 克隆出的副本**。
 * 要让这件事在字节层面可断言，写入通道必须从「内核条目算完重序列化整本」
 * （`toWorldbookData`）改成**在原始 JSON 上只增一条**：
 *   · 原书其它条目的字段全集（含 App **不认识**的上游字段 `selectiveLogic` /
 *     `scanDepth` / `matchWholeWords` / `sticky` / `role` …）**一个字节都不动**；
 *   · `uid` / 字典键**不重编号**（重编号会把「未改动」变成「已改动」）。
 * 因此本模块**只认原始形态**（`Record<key, rawEntry>`），内核形态
 * （`WorldInfoEntry`）只用于「构造学习条目自身」与 UI 展示。
 *
 * ── 两条硬不变量（C-06 / R-02 / R-11；LG-2 / LG-5 断言的对象）──────────────
 * ① **非学习条目冻结**：写入前的「非学习条目序列」（字典序 + 逐条序列化字节）
 *    必须是写入后的**前缀**（`invariantReport` 的 `nonLearnedPrefix`）。
 *    弱化成「子序列」是不够的——那会放过「条目被换位」。
 * ② **学习条目单调且不可变**：写入前已存在的每个 `learnedId`，写入后仍在，
 *    且条目字节不变（只增不改）。**同 `learnedId` = no-op 跳过**，不做合并、
 *    不做覆盖（`mergeLearnedEntry` 的 `filter+push` 会被这条断言当场判死）。
 * 违背任一 → 调用方**拒绝发起写入**（fail-closed）。
 *
 * ── `learnedId` 为什么必须内容派生（P2）─────────────────────────────────────
 * 顺序下标派生（`learned:${uid}` / `learned:${index}`）下，「同 id」既可能在
 * 覆盖一条旧条目、也可能在跳过一条真新条目，两种语义无法区分。改为
 * `hash(kind, 归一化 key 集, 正文)`：内容相同 ⇒ 同 id（幂等跳过）；
 * 内容改过 ⇒ 新 id（**追加**而非覆盖——这正是「只增不改」要的行为）。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 学习产物固定注入位置：1 = 后置（尾缀区），**永不为 0**（R-07 冻结前缀块）。 */
export const LEARNED_POSITION = 1;

/** 写入的触发词个数上限（`key` 取前 N 个；词表已按文档频率降序）。 */
export const LEARNED_MAX_KEYS = 6;

/** `extensions.learnedId` 的取值前缀，用于一眼看出条目来源。 */
export const LEARNED_ID_PREFIX = 'learned:';

/** 副本书名后缀与时间戳（§4.3⑥：`《原书》·学习副本@YYYY-MM-DD HHmm`，重名加 `·2`）。 */
export const COPY_SUFFIX = '·学习副本';

/** 只有携带可注入正文的两类进世界书；另三类是观测性产物（无正文，不落盘）。 */
export const APPLIABLE_KINDS = ['cluster', 'template'] as const;
export type AppliableKind = (typeof APPLIABLE_KINDS)[number];

export function isAppliable(kind: string): boolean {
  return (APPLIABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * 写入侧硬配额（P5：配额是**唯一**刹车，且满时**显性暂停**、禁静默丢弃）。
 *
 * 40/40 与「单轮各 8」为初值；`learning-quota-probe.mjs` 在 4000 条量级异质语料上
 * 实测后定稿（spec §10.7 挂起实证项之一）。
 */
export const QUOTA_PER_KIND: Record<AppliableKind, number> = { cluster: 40, template: 40 };
export const QUOTA_PER_ROUND = 8;

// ---------------------------------------------------------------------------
// 原始形态访问
// ---------------------------------------------------------------------------

/** 原始条目：字段全集（含 App 不认识的），值不可信任。 */
export type RawEntry = Record<string, unknown>;

/** 取原始条目字典；形态不对返回 null（**不抛**，由调用方决定报错文案）。 */
export function rawEntriesOf(book: unknown): Record<string, RawEntry> | null {
  if (!book || typeof book !== 'object') return null;
  const raw = (book as { entries?: unknown }).entries;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, RawEntry>;
}

/** 该条目的 `extensions.learnedId`（非学习条目 / 形态不对 → null）。 */
export function learnedIdOfEntry(e: RawEntry | null | undefined): string | null {
  const ext = e?.extensions;
  if (!ext || typeof ext !== 'object') return null;
  const id = (ext as { learnedId?: unknown }).learnedId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function isLearnedEntry(e: RawEntry | null | undefined): boolean {
  return learnedIdOfEntry(e) !== null;
}

/** 该书里的学习条目（按 `learnedKind` 分桶计数）。 */
export function learnedCountsOf(book: unknown): { cluster: number; template: number; other: number } {
  const out = { cluster: 0, template: 0, other: 0 };
  const entries = rawEntriesOf(book);
  if (!entries) return out;
  for (const e of Object.values(entries)) {
    const id = learnedIdOfEntry(e);
    if (id === null) continue;
    const kind = (e.extensions as { learnedKind?: unknown } | undefined)?.learnedKind;
    if (kind === 'cluster') out.cluster++;
    else if (kind === 'template') out.template++;
    else out.other++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 内容派生 `learnedId`（P2）
// ---------------------------------------------------------------------------

/** FNV-1a（32 位，两次不同种子 → 16 位十六进制；规模 ≤ 数百条，碰撞面可忽略）。 */
function hash32(s: string, seed: number): string {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 触发词归一化：去空白、去重、保序、截断（`key` 与 id 用**同一**口径）。 */
export function normalizeKeys(keys: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const k of keys ?? []) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= LEARNED_MAX_KEYS) break;
  }
  return out;
}

/**
 * 内容派生的稳定标识。**禁止**改为顺序下标派生（P2 明令）。
 * 归一化保证「同内容 ⇒ 同 id」，与传入顺序、数组下标无关。
 */
export function contentLearnedId(kind: string, keys: readonly unknown[] | undefined, content: string): string {
  const canon = JSON.stringify([kind, normalizeKeys(keys), content.trim()]);
  return `${LEARNED_ID_PREFIX}${hash32(canon, 0x811c9dc5)}${hash32(canon, 0xcbf29ce4)}`;
}

// ---------------------------------------------------------------------------
// 学习条目构造（原始形态）
// ---------------------------------------------------------------------------

/** 单条建议的落盘输入（壳从 `SuggestionItem` + 正文文本构造）。 */
export interface LearnedDraft {
  /** 台账 uid（`cluster:xxx` / `template:yyy`）——只用于台账，不参与 id 派生 */
  uid: string;
  title: string;
  keys: string[];
  content: string;
  kind: string;
}

/**
 * 草稿 → 原始条目。**只写 App 认识的 11 个字段**（新条目如此即可；
 * 已存在条目的字段全集由原样透传保证，不在这里重建）。
 * 无触发词 / 无正文 → null（**不可落盘**，由调用方显性提示）。
 */
export function learnedRawEntry(
  d: LearnedDraft,
  learnedId: string,
  at: string | null,
  uid: number,
): RawEntry | null {
  const content = d.content.trim();
  if (!content) return null;
  const keys = normalizeKeys(d.keys);
  if (keys.length === 0) return null;
  return {
    uid,
    key: keys,
    content,
    comment: `[学习] ${d.title}`.slice(0, 120),
    position: LEARNED_POSITION,
    extensions: { learnedId, learnedKind: d.kind, learnedAt: at },
  };
}

// ---------------------------------------------------------------------------
// 克隆与命名
// ---------------------------------------------------------------------------

/** 时间戳 `YYYY-MM-DD HHmm`（本地时区；副本名可读性优先）。 */
export function stampOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    ` ${p(date.getHours())}${p(date.getMinutes())}`
  );
}

/** 副本书名；重名依次加 `·2`、`·3`…（`existing` 传入后端已有书名全表）。 */
export function copyNameFor(source: string, stamp: string, existing: readonly string[]): string {
  const base = `${source.trim()}${COPY_SUFFIX}@${stamp}`;
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}·${i}`;
    if (!existing.includes(cand)) return cand;
  }
  return `${base}·${Date.now()}`;
}

/**
 * **原样克隆**：浅拷贝顶层、只改 `name`，`entries` 字典与每个条目对象**整体复用**。
 * 因此除 `name` 的值以外，副本与原书逐字节一致（`entries` 里 App 不认识的字段一并保留）。
 */
export function rawCloneOf(book: unknown, newName: string): Record<string, unknown> | null {
  if (!book || typeof book !== 'object' || Array.isArray(book)) return null;
  const src = book as Record<string, unknown>;
  if (rawEntriesOf(src) === null) return null; // entries 形态不对 → 不能作为副本基线
  return { ...src, name: newName };
}

// ---------------------------------------------------------------------------
// 追加 / 摘除（只增不改）
// ---------------------------------------------------------------------------

/** 下一个可用的字典键：数字键的最大值 + 1（无数字键 → `'0'`）。 */
export function nextEntryKey(entries: Record<string, RawEntry>): string {
  let max = -1;
  for (const k of Object.keys(entries)) {
    if (!/^\d+$/.test(k)) continue;
    const n = Number(k);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * 浅拷贝出「可安全改动」的书（顶层 + entries 字典；**条目对象不复制、不重建**）。
 *
 * ⚠ 必须把**复制后的** entries 字典挂回新书：只写 `{ ...book }` 会让新书的
 * `entries` 仍指向原字典，于是「往副本字典里加条目」对返回值不可见 ——
 * 结果是**静默 no-op 写入**（报告成功却没写进去）。G4′ 门禁抓过这个形态。
 */
function mutableCopy(book: unknown): { book: Record<string, unknown>; entries: Record<string, RawEntry> } | null {
  const entries = rawEntriesOf(book);
  if (!entries || !book || typeof book !== 'object') return null;
  const outEntries: Record<string, RawEntry> = { ...entries };
  return { book: { ...(book as Record<string, unknown>), entries: outEntries }, entries: outEntries };
}

export interface AppendResult {
  /** 新书（未变条目与原书**共享引用**，字节等价） */
  book: Record<string, unknown> | null;
  appended: { uid: string; learnedId: string; key: string }[];
  /** 因「同 `learnedId` 已存在」而跳过的 uid（P1：no-op，不合并、不覆盖） */
  skippedDuplicate: string[];
  /** 因条目构造失败（无正文/无触发词）而跳过的 uid */
  skippedUnbuildable: string[];
}

/**
 * 追加学习条目（**唯一**的写入原语）。
 * 不改动任何既有条目，也不重编号：新条目一律用 `nextEntryKey` 落在字典尾部。
 */
export function appendLearned(book: unknown, drafts: readonly LearnedDraft[], at: string | null): AppendResult {
  const copy = mutableCopy(book);
  if (!copy) return { book: null, appended: [], skippedDuplicate: [], skippedUnbuildable: [] };
  const { book: out, entries } = copy;

  const seen = new Set<string>();
  for (const e of Object.values(entries)) {
    const id = learnedIdOfEntry(e);
    if (id !== null) seen.add(id);
  }

  const appended: AppendResult['appended'] = [];
  const skippedDuplicate: string[] = [];
  const skippedUnbuildable: string[] = [];

  for (const d of drafts) {
    const learnedId = contentLearnedId(d.kind, d.keys, d.content);
    if (seen.has(learnedId)) {
      skippedDuplicate.push(d.uid);
      continue;
    }
    const key = nextEntryKey(entries);
    const entry = learnedRawEntry(d, learnedId, at, Number(key));
    if (!entry) {
      skippedUnbuildable.push(d.uid);
      continue;
    }
    entries[key] = entry;
    seen.add(learnedId);
    appended.push({ uid: d.uid, learnedId, key });
  }
  return { book: out, appended, skippedDuplicate, skippedUnbuildable };
}

/** 按下标摘除学习条目（**撤销**与**整体回滚**共用）。其它条目一律不动、不重编号。 */
export function removeLearnedIds(
  book: unknown,
  ids: readonly string[],
): { book: Record<string, unknown> | null; removed: number } {
  const copy = mutableCopy(book);
  if (!copy) return { book: null, removed: 0 };
  const want = new Set(ids);
  let removed = 0;
  for (const [k, e] of Object.entries(copy.entries)) {
    const id = learnedIdOfEntry(e);
    if (id !== null && want.has(id)) {
      delete copy.entries[k];
      removed++;
    }
  }
  return { book: copy.book, removed };
}

/** 一键整体回滚：摘掉**全部**学习条目（对用户手改过的副本同样只摘学习产物）。 */
export function removeAllLearned(book: unknown): { book: Record<string, unknown> | null; removed: number } {
  const entries = rawEntriesOf(book);
  if (!entries) return { book: null, removed: 0 };
  const ids: string[] = [];
  for (const e of Object.values(entries)) {
    const id = learnedIdOfEntry(e);
    if (id !== null) ids.push(id);
  }
  return removeLearnedIds(book, ids);
}

// ---------------------------------------------------------------------------
// 写入许可（fail-closed）
// ---------------------------------------------------------------------------

/**
 * 写入许可（**唯一**判据，`suggest-gate` 与门禁共用）。
 *
 * 「禁止向非副本提交」的可判定实现：任何一条不满足即**拒写**（fail-closed）。
 * 三条各自堵一个真实后果：
 * ① 无沙盒 → 会让产物落到用户原书（2026-08-08 禁令的射程）；
 * ② 副本名 == 源书名 → 沙盒记录被改坏时会把**原书**当副本写（克隆语义不成立）；
 * ③ 副本不是激活书 → 写进去也不会被注入（用户以为学到了，其实没有）。
 */
export interface WriteGuard {
  ok: boolean;
  code: 'noSandbox' | 'copyIsSource' | 'copyNotActive' | null;
  reason: string | null;
}

export function writesAllowed(
  sandbox: { copyName: string; sourceName: string } | null,
  activeName: string | null,
): WriteGuard {
  if (!sandbox) {
    return {
      ok: false,
      code: 'noSandbox',
      reason: '学习产物只能写进副本：请先创建学习副本（克隆当前启用的世界书）。',
    };
  }
  if (sandbox.copyName === sandbox.sourceName) {
    return {
      ok: false,
      code: 'copyIsSource',
      reason: `副本名与源书名相同（《${sandbox.copyName}》），无法区分原书与副本 —— 已拒绝写入。`,
    };
  }
  if (activeName !== sandbox.copyName) {
    return {
      ok: false,
      code: 'copyNotActive',
      reason: `副本《${sandbox.copyName}》当前不是启用的世界书（写进去也不会被注入）—— 请先启用副本。`,
    };
  }
  return { ok: true, code: null, reason: null };
}

// ---------------------------------------------------------------------------
// 双不变量（机器可判定；fail-closed 的判据）
// ---------------------------------------------------------------------------

export interface InvariantViolation {
  code: 'nonLearnedChanged' | 'learnedRemoved' | 'learnedRewritten' | 'notMutable';
  detail: string;
}

/** 非学习条目序列：`[字典键, 条目字节]`（字典序即文件序）。 */
function nonLearnedSeq(book: unknown): { key: string; bytes: string }[] {
  const entries = rawEntriesOf(book);
  if (!entries) return [];
  const out: { key: string; bytes: string }[] = [];
  for (const [k, e] of Object.entries(entries)) {
    if (isLearnedEntry(e)) continue;
    out.push({ key: k, bytes: JSON.stringify(e) });
  }
  return out;
}

/** 学习条目表：`learnedId → 条目字节`。 */
function learnedBytes(book: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entries = rawEntriesOf(book);
  if (!entries) return out;
  for (const e of Object.values(entries)) {
    const id = learnedIdOfEntry(e);
    if (id !== null) out.set(id, JSON.stringify(e));
  }
  return out;
}

/**
 * 不变量报告。
 *
 * · `mode: 'append'`：① 非学习序列前缀不变；② 已有学习条目一个不少、字节不变
 *   （新增的学习条目不计入，那是**允许**的变更）。
 * · `mode: 'revert'`：① 同上；② 只允许**指定 id** 的学习条目消失，其余学习条目字节不变。
 */
export function invariantReport(
  before: unknown,
  after: unknown,
  opts: { mode: 'append' } | { mode: 'revert'; allowRemovedIds: readonly string[] },
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  if (rawEntriesOf(after) === null) {
    return [{ code: 'notMutable', detail: '写入后的书 entries 形态不合法' }];
  }

  const b = nonLearnedSeq(before);
  const a = nonLearnedSeq(after);
  for (let i = 0; i < b.length; i++) {
    if (i >= a.length) {
      violations.push({
        code: 'nonLearnedChanged',
        detail: `非学习条目「${b[i].key}」在写入后消失（原序列是写入后序列的前缀这一条不成立）`,
      });
      break;
    }
    if (a[i].key !== b[i].key) {
      violations.push({
        code: 'nonLearnedChanged',
        detail: `非学习条目第 ${i} 位被换位：${b[i].key} → ${a[i].key}`,
      });
      break;
    }
    if (a[i].bytes !== b[i].bytes) {
      violations.push({
        code: 'nonLearnedChanged',
        detail: `非学习条目「${b[i].key}」的字节被改动`,
      });
      break;
    }
  }

  const lb = learnedBytes(before);
  const la = learnedBytes(after);
  for (const [id, bytes] of lb) {
    const now = la.get(id);
    if (now === undefined) {
      if (opts.mode === 'revert' && opts.allowRemovedIds.includes(id)) continue;
      violations.push({ code: 'learnedRemoved', detail: `学习条目 ${id} 被删除（只增不改要求它仍在）` });
      continue;
    }
    if (now !== bytes) {
      violations.push({ code: 'learnedRewritten', detail: `学习条目 ${id} 被改写（只增不改要求字节不变）` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 克隆快照 / 增量视图（相对克隆快照的 新增 / 修改 / 删除）
// ---------------------------------------------------------------------------

/**
 * 克隆快照 = **非学习条目**的 uid → 条目字节哈希，加内容哈希多重集。
 * 不存整份副本正文（一个 4000 条的世界书正文可达数 MB，localStorage 只有 5 MB），
 * 但足以判定「副本基线是否被人手改过」—— 这正是增量视图要回答的问题。
 *
 * 身份口径：有数字 `uid` 用 `uid`，否则用 `#字典键`（`parseWorldbook` 的
 * `fallbackUid` 会补 uid，故原始层缺 uid 只能按字典键定位）。
 */
export interface CopyDigest {
  v: 1;
  at: string | null;
  count: number;
  byUid: Record<string, string>;
  byHash: Record<string, number>;
}

function digestHash(bytes: string): string {
  return `${hash32(bytes, 0x811c9dc5)}${hash32(bytes, 0xcbf29ce4)}`;
}

export function digestOf(book: unknown): CopyDigest {
  const entries = rawEntriesOf(book);
  const byUid: Record<string, string> = {};
  const byHash: Record<string, number> = {};
  let count = 0;
  if (entries) {
    for (const [k, e] of Object.entries(entries)) {
      if (isLearnedEntry(e)) continue;
      const h = digestHash(JSON.stringify(e));
      const uid = (e as { uid?: unknown }).uid;
      byUid[typeof uid === 'number' ? String(uid) : `#${k}`] = h;
      byHash[h] = (byHash[h] ?? 0) + 1;
      count++;
    }
  }
  return { v: 1, at: null, count, byUid, byHash };
}

export interface CopyDelta {
  /** 学习追加的条目数（带 `extensions.learnedId`） */
  addedByLearning: number;
  /** 快照里没有、且没有 `learnedId` 的条目数（用户手加） */
  addedByUser: number;
  /** 同一 uid 内容变了 */
  edited: number;
  /** uid 消失且内容也找不到 */
  removed: number;
  /** 内容仍在但 uid 变了（被别的工具重编号） */
  renumbered: number;
}

/**
 * 增量视图。归因是**近似**的（快照只存哈希，不做行级 diff）：
 * 保守优先——宁可报「未变」也不把用户的改动误报成学习产物。
 */
export function deltaVsSnapshot(digest: CopyDigest, book: unknown): CopyDelta {
  const cur = digestOf(book);
  const pool: Record<string, number> = { ...cur.byHash };
  let edited = 0;
  let removed = 0;
  let renumbered = 0;

  for (const [id, h] of Object.entries(digest.byUid)) {
    const nowH = cur.byUid[id];
    if (nowH === h) {
      pool[h] = (pool[h] ?? 0) - 1;
      continue;
    }
    if (nowH !== undefined) {
      edited++;
      if ((pool[h] ?? 0) > 0) pool[h] = pool[h] - 1;
      continue;
    }
    if ((pool[h] ?? 0) > 0) {
      pool[h] = pool[h] - 1;
      renumbered++;
      continue;
    }
    removed++;
  }

  let addedByUser = 0;
  for (const id of Object.keys(cur.byUid)) {
    if (digest.byUid[id] === undefined) addedByUser++;
  }
  const counts = learnedCountsOf(book);
  return {
    addedByLearning: counts.cluster + counts.template + counts.other,
    addedByUser,
    edited,
    removed,
    renumbered,
  };
}

// ---------------------------------------------------------------------------
// 配额（P5）
// ---------------------------------------------------------------------------

export interface QuotaStatus {
  cluster: number;
  template: number;
  limitCluster: number;
  limitTemplate: number;
  /** 任一类触顶 → 学习进入**显性暂停**态（禁静默丢弃） */
  paused: boolean;
  reason: string | null;
}

export function quotaStatusOf(book: unknown): QuotaStatus {
  const c = learnedCountsOf(book);
  const pausedCluster = c.cluster >= QUOTA_PER_KIND.cluster;
  const pausedTemplate = c.template >= QUOTA_PER_KIND.template;
  const paused = pausedCluster || pausedTemplate;
  const parts: string[] = [];
  if (pausedCluster) parts.push(`候选簇已达上限 ${QUOTA_PER_KIND.cluster}`);
  if (pausedTemplate) parts.push(`模板行已达上限 ${QUOTA_PER_KIND.template}`);
  return {
    cluster: c.cluster,
    template: c.template,
    limitCluster: QUOTA_PER_KIND.cluster,
    limitTemplate: QUOTA_PER_KIND.template,
    paused,
    reason: paused ? `${parts.join('；')} —— 学习已暂停写入（不会静默丢弃，处理后可继续）` : null,
  };
}

export interface RoundSkip {
  notAppliable: number;
  duplicate: number;
  perRound: number;
  quotaFull: number;
  unbuildable: number;
  total(): number;
}

export interface RoundPlan {
  accepted: LearnedDraft[];
  skip: RoundSkip;
  status: QuotaStatus;
}

/**
 * 一轮静默写入的**唯一**决策点：先按配额筛，再把筛过的交给 `appendLearned`。
 *
 * 顺序敏感：`drafts` 必须由调用方按确定性顺序给出（confidence 降序 + uid 兜底），
 * 否则「本轮谁被留下」不可复现。
 */
export function planRound(book: unknown, drafts: readonly LearnedDraft[]): RoundPlan {
  const base = learnedCountsOf(book);
  const counts: Record<AppliableKind, number> = { cluster: base.cluster, template: base.template };
  const perRound: Record<AppliableKind, number> = { cluster: 0, template: 0 };

  const skip = {
    notAppliable: 0,
    duplicate: 0,
    perRound: 0,
    quotaFull: 0,
    unbuildable: 0,
    total(this: { notAppliable: number; duplicate: number; perRound: number; quotaFull: number; unbuildable: number }) {
      return this.notAppliable + this.duplicate + this.perRound + this.quotaFull + this.unbuildable;
    },
  } as RoundSkip;

  const seen = new Set<string>();
  const entries = rawEntriesOf(book);
  if (entries) {
    for (const e of Object.values(entries)) {
      const id = learnedIdOfEntry(e);
      if (id !== null) seen.add(id);
    }
  }

  const accepted: LearnedDraft[] = [];
  for (const d of drafts) {
    if (!isAppliable(d.kind)) {
      skip.notAppliable++;
      continue;
    }
    const kind = d.kind as AppliableKind;
    if (!d.content.trim() || normalizeKeys(d.keys).length === 0) {
      skip.unbuildable++;
      continue;
    }
    if (counts[kind] >= QUOTA_PER_KIND[kind]) {
      skip.quotaFull++;
      continue;
    }
    if (perRound[kind] >= QUOTA_PER_ROUND) {
      skip.perRound++;
      continue;
    }
    const id = contentLearnedId(d.kind, d.keys, d.content);
    if (seen.has(id)) {
      skip.duplicate++;
      continue;
    }
    seen.add(id);
    counts[kind]++;
    perRound[kind]++;
    accepted.push(d);
  }

  const pausedCluster = counts.cluster >= QUOTA_PER_KIND.cluster;
  const pausedTemplate = counts.template >= QUOTA_PER_KIND.template;
  const parts: string[] = [];
  if (pausedCluster) parts.push(`候选簇已达上限 ${QUOTA_PER_KIND.cluster}`);
  if (pausedTemplate) parts.push(`模板行已达上限 ${QUOTA_PER_KIND.template}`);
  return {
    accepted,
    skip,
    status: {
      cluster: counts.cluster,
      template: counts.template,
      limitCluster: QUOTA_PER_KIND.cluster,
      limitTemplate: QUOTA_PER_KIND.template,
      paused: pausedCluster || pausedTemplate,
      reason: parts.length ? `${parts.join('；')} —— 学习已暂停写入（不会静默丢弃）` : null,
    },
  };
}

/** 配额余量文案（可观测项之一；UI 与服务端日志同口径）。 */
export function quotaLineOf(s: QuotaStatus): string {
  return `学习条目：候选簇 ${s.cluster}/${s.limitCluster} · 模板行 ${s.template}/${s.limitTemplate}`;
}
