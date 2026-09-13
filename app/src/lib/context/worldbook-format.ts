/**
 * 世界书「内核条目 ↔ ST 原生形态」格式转换。// [SSA-LEARN]
 *
 * ── 为什么从 store 里搬出来 ────────────────────────────────────────────────
 * 这两个函数是**纯函数**（只做结构转换），原先住在 `stores/worldbook.svelte.ts`。
 * 但 `.svelte.ts` 里的 `$state` 必须经 Svelte 编译，**Node 里 import 不了**，
 * 于是 Phase 4 的 G4 门禁（往返无损断言）就只能测一份「抄来的副本」——
 * 那等于没测。搬到纯 `.ts` 后门禁直接 import 生产代码。
 * store 侧保持再导出，既有 import 路径不变（零行为变化）。
 *
 * ── ST 形态要点 ───────────────────────────────────────────────────────────
 * ST 的 `entries` 是**以序号字符串为键的对象**（`"0"`, `"1"`, …），不是数组；
 * 且字段可能缺失、uid 可能重复。转换只做结构搬运，**字段校验交给内核的
 * `normalizeEntries`**（单一职责）。
 */

// 显式 `.ts` 后缀：本模块要能被 Node 直接 import（G4 门禁），见 provision/index.ts 同款做法
import { normalizeEntries, type WorldInfoEntry } from './assembler.ts';

/** 原始 ST 条目（字段可缺，全部按可选处理 —— 外部 JSON 不可信）。 */
export interface RawEntry {
  uid?: number;
  key?: unknown;
  keysecondary?: unknown;
  content?: unknown;
  comment?: unknown;
  constant?: boolean;
  probability?: number;
  order?: number;
  position?: number;
  depth?: number;
  disable?: boolean;
  extensions?: Record<string, unknown>;
}

/** ST 原生世界书形态（`entries` 为字典而非数组）。 */
export interface WorldbookData {
  entries: Record<string, RawEntry>;
  name: string;
}

/**
 * 正向转换：ST 原生世界书 → 内核条目数组。
 *
 * 兼容两种形态：对象字典（ST 原生）/ 数组（部分导出工具）。
 * uid 缺失时补一个（内核按 uid 建簇映射，缺失会导致簇成员错乱）。
 */
export function parseWorldbook(book: unknown): WorldInfoEntry[] {
  const raw = (book as { entries?: unknown })?.entries;
  if (!raw) return [];

  const items: RawEntry[] = Array.isArray(raw)
    ? (raw as RawEntry[])
    : Object.values(raw as Record<string, RawEntry>);

  let fallbackUid = 0;
  return normalizeEntries(
    items
      .filter((e): e is RawEntry => !!e && typeof e === 'object')
      .map((e) => ({
        uid: typeof e.uid === 'number' ? e.uid : fallbackUid++,
        key: e.key as string[],
        keysecondary: e.keysecondary as string[] | undefined,
        content: typeof e.content === 'string' ? e.content : '',
        comment: typeof e.comment === 'string' ? e.comment : undefined,
        constant: e.constant === true,
        probability: typeof e.probability === 'number' ? e.probability : undefined,
        order: typeof e.order === 'number' ? e.order : undefined,
        position: typeof e.position === 'number' ? e.position : undefined,
        depth: typeof e.depth === 'number' ? e.depth : undefined,
        disable: e.disable === true,
        extensions: e.extensions,
      })),
  );
}

/**
 * 反向转换：内核条目数组 → ST 原生世界书形态（`parseWorldbook` 的逆）。
 *
 * ── 为什么要 re-index ──────────────────────────────────────────────────────
 * ST 的 `entries` 是以序号字符串为键的对象，且 `uid` 与该键一一对应。
 * 内核条目可能因导入/新建出现 uid 缺失或重复（`parseWorldbook` 的 fallbackUid
 * 可能与已有 uid 撞车），若直接用 uid 作键会覆盖同键条目（静默丢数据）。
 * 因此写回时**按数组下标重新编号**，同时把 `uid` 同步写下标 —— 保证
 * 「键 ↔ uid」严格一致且唯一，二次读取可无损还原（round-trip）。
 *
 * 字段名回到 ST 原生（key / content / comment / constant / disable …），
 * 仅填写有值的字段，避免写出一堆 undefined 污染文件。
 */
export function toWorldbookData(entries: WorldInfoEntry[], name: string): WorldbookData {
  const out: Record<string, RawEntry> = {};
  entries.forEach((e, i) => {
    const raw: RawEntry = {
      uid: i,
      key: Array.isArray(e.key) ? e.key : [],
      content: typeof e.content === 'string' ? e.content : '',
    };
    if (e.keysecondary && e.keysecondary.length > 0) raw.keysecondary = e.keysecondary;
    if (e.comment) raw.comment = e.comment;
    if (e.constant) raw.constant = true;
    if (e.probability !== undefined) raw.probability = e.probability;
    if (e.order !== undefined) raw.order = e.order;
    if (e.position !== undefined) raw.position = e.position;
    if (e.depth !== undefined) raw.depth = e.depth;
    if (e.disable) raw.disable = true;
    // 保留 SSA 扩展命名空间（static / clusterId / learnedId）及其它未知字段，保证可回退
    if (e.extensions && Object.keys(e.extensions).length > 0) raw.extensions = e.extensions;
    out[String(i)] = raw;
  });
  return { entries: out, name };
}
