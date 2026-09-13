/**
 * 世界书 store。
 *
 * ── 为什么需要独立 store ──────────────────────────────────────────────────
 * 上下文组装（assembleContext）的**输入**就是世界书条目集。此前 app 只有
 * 角色卡（name/description），没有任何世界书数据源，所以内核虽然完备却无从接线。
 *
 * ── 数据来源（逐字段取证）────────────────────────────────────────────────
 * · 列表：`POST /api/worldinfo/list` → `[{ file_id, name, extensions }]`
 *   （`src/endpoints/worldinfo.js:151-181`）
 * · 内容：`POST /api/worldinfo/get` body `{ name }` → 世界书 JSON
 *   （`src/endpoints/worldinfo.js:183-195`）
 * · 文件格式为 SillyTavern 原生：`entries` 是**以序号字符串为键的对象**，
 *   不是数组（`"0"`, `"1"`, …）。因此必须转换后才能喂给内核。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────────
 * 内置降级后端（无完整世界书接口）会返回 404；此时 `entries` 保持空数组，
 * 组装退化为「仅角色设定」，不报错、不影响聊天。
 */

import { getBaseUrl } from '../lib/backend';
import { getCsrfToken } from '../lib/chat';
import { normalizeEntries, type WorldInfoEntry } from '../lib/context/assembler';
import { convertToLiveCluster } from '../lib/context/live-cluster-worldbook';
import { logger } from '../lib/logger';

const KEY = 'tavern.worldbook';

export interface WorldbookMeta {
  fileId: string;
  name: string;
}

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

class WorldbookStore {
  /** 后端可用的世界书列表 */
  list = $state<WorldbookMeta[]>([]);
  /** 当前激活的世界书名（null = 不启用世界书） */
  activeName = $state<string | null>(null);
  /**
   * 当前激活世界书的条目（已归一化为内核的 WorldInfoEntry）。
   * 注意：这里保存的是**原版语义**条目；活簇转换在组装时按需进行（有记忆化缓存）。
   */
  entries = $state<WorldInfoEntry[]>([]);
  /** 是否已尝试加载过（避免重复拉取） */
  loaded = $state(false);
  /** 加载失败原因（仅入日志/调试面板，不面向普通用户） */
  lastError = $state<string | null>(null);
  /** 最近一次写操作（新建/保存/删除/重命名）的失败原因，供 UI 展示 */
  lastWriteError = $state<string | null>(null);
  /** 写操作进行中（UI 用于禁用按钮/显示进度） */
  writing = $state(false);

  constructor() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) this.activeName = JSON.parse(saved).activeName ?? null;
    } catch {
      /* 静默 */
    }
  }

  /** 拉取世界书列表；若已有激活项则顺带加载其内容。 */
  async load(force = false) {
    if (this.loaded && !force) return;
    this.lastError = null;
    try {
      const res = await fetch(`${getBaseUrl()}/api/worldinfo/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        // 降级后端没有该接口（404）→ 空列表，不影响聊天
        logger.debug('worldbook', '世界书列表不可用', { status: res.status });
        this.list = [];
        this.loaded = true;
        return;
      }
      const data = (await res.json()) as { file_id?: string; name?: string }[];
      this.list = (Array.isArray(data) ? data : []).map((w) => ({
        fileId: String(w.file_id ?? w.name ?? ''),
        name: String(w.name ?? w.file_id ?? ''),
      }));
      logger.info('worldbook', '世界书列表已加载', { count: this.list.length });

      // 若已选中的世界书仍存在，加载其内容
      if (this.activeName && this.list.some((w) => w.name === this.activeName)) {
        await this.select(this.activeName);
      }
    } catch (e) {
      logger.debug('worldbook', '世界书列表拉取失败', e);
      this.list = [];
    } finally {
      this.loaded = true;
    }
  }

  /** 选择某个世界书并加载其条目；传 null 表示停用。 */
  async select(name: string | null) {
    this.activeName = name;
    this.persist();
    if (!name) {
      this.entries = [];
      logger.info('worldbook', '已停用世界书');
      return;
    }
    try {
      const res = await fetch(`${getBaseUrl()}/api/worldinfo/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        this.entries = [];
        this.lastError = `世界书加载失败（${res.status}）`;
        logger.warn('worldbook', '世界书内容不可用', { name, status: res.status });
        return;
      }
      const book = await res.json();
      this.entries = parseWorldbook(book);
      logger.info('worldbook', '世界书已加载', { name, entries: this.entries.length });
    } catch (e) {
      this.entries = [];
      this.lastError = e instanceof Error ? e.message : String(e);
      logger.warn('worldbook', '世界书加载异常', e);
    }
  }

  /**
   * 返回**启用且适合当前机制**的条目集：
   * 开启活簇世界书时自动转换（社区书零改装升级），否则原样返回。
   *
   * 转换结果有记忆化缓存（见 live-cluster-worldbook.ts），多轮复用零成本。
   */
  entriesFor(opts: { liveCluster: boolean }): WorldInfoEntry[] {
    if (this.entries.length === 0) return [];
    if (!opts.liveCluster) return this.entries;
    return convertToLiveCluster(this.entries).entries;
  }

  // -------------------------------------------------------------------------
  // 写操作（创建 / 保存 / 删除 / 重命名）
  //
  // 后端全部为 POST，写操作需带 CSRF（复用 chat.ts 的 getCsrfToken）。
  // 降级后端没有这些端点（404/405）→ 返回 false 并给出可读错误，不抛异常、不白屏。
  // -------------------------------------------------------------------------

  /** 统一的写请求：自动附带 CSRF 头与超时；返回 Response（由调用方判 status）。 */
  private async postWrite(path: string, body: unknown): Promise<Response> {
    const token = await getCsrfToken();
    return fetch(`${getBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-CSRF-Token': token } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }

  /** 把后端返回的错误转成对用户可读的中文提示。 */
  private readWriteError(status: number): string {
    if (status === 404 || status === 405) return '当前后端不支持世界书管理（可能是精简后端）';
    if (status === 409) return '已存在同名世界书，请换一个名字';
    if (status === 400) return '名字或内容不合法，请检查后重试';
    if (status === 401 || status === 403) return '无权限写入（登录或安全令牌失效）';
    return `操作失败（${status}）`;
  }

  /**
   * 新建或覆盖一本世界书（两者后端共用 `/api/worldinfo/edit`）。
   *
   * `data` 为 ST 原生形态 `{ entries: { "0": {...} }, name }`；
   * `isValidWorldInfoData` 要求 entries 为非数组对象，空书用 `{}` 即可。
   */
  async save(name: string, data: unknown): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) {
      this.lastWriteError = '世界书名字不能为空';
      return false;
    }
    this.writing = true;
    this.lastWriteError = null;
    try {
      const res = await this.postWrite('/api/worldinfo/edit', { name: trimmed, data });
      if (!res.ok) {
        this.lastWriteError = this.readWriteError(res.status);
        logger.warn('worldbook', '保存世界书失败', { name: trimmed, status: res.status });
        return false;
      }
      // 写完后重新拉列表；load 内部若激活书仍存在会顺带刷新 entries，
      // 因此（激活书被编辑时）UI 与后端即刻一致，不会显示陈旧数据。
      // 注意：保存一本**非激活**书不会把它激活（激活由 UI 的选中操作显式触发）。
      await this.load(true);
      logger.info('worldbook', '世界书已保存', { name: trimmed });
      return true;
    } catch (e) {
      this.lastWriteError = e instanceof Error ? e.message : String(e);
      logger.warn('worldbook', '保存世界书异常', e);
      return false;
    } finally {
      this.writing = false;
    }
  }

  /** 新建空世界书（`{ entries: {}, name }`）。 */
  async create(name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) {
      this.lastWriteError = '世界书名字不能为空';
      return false;
    }
    if (this.list.some((w) => w.name === trimmed)) {
      this.lastWriteError = '已存在同名世界书，请换一个名字';
      return false;
    }
    return this.save(trimmed, { entries: {}, name: trimmed });
  }

  /** 保存某个世界书的条目（把内核条目反归一化为 ST 原生形态后写回）。 */
  async saveEntries(name: string, entries: WorldInfoEntry[]): Promise<boolean> {
    return this.save(name, toWorldbookData(entries, name));
  }

  /**
   * 只读某本世界书的条目（不改变当前激活态）。
   * 用于「编辑非激活书」与「列表条目计数」——它们都不应触发激活切换。
   */
  async readEntries(name: string): Promise<WorldInfoEntry[]> {
    try {
      const res = await fetch(`${getBaseUrl()}/api/worldinfo/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        this.lastWriteError = this.readWriteError(res.status);
        return [];
      }
      return parseWorldbook(await res.json());
    } catch (e) {
      this.lastWriteError = e instanceof Error ? e.message : String(e);
      return [];
    }
  }

  /** 删除世界书；若删的是当前激活书则清空激活态。 */
  async remove(name: string): Promise<boolean> {
    this.writing = true;
    this.lastWriteError = null;
    try {
      const res = await this.postWrite('/api/worldinfo/delete', { name });
      if (!res.ok) {
        this.lastWriteError = this.readWriteError(res.status);
        logger.warn('worldbook', '删除世界书失败', { name, status: res.status });
        return false;
      }
      if (this.activeName === name) {
        this.activeName = null;
        this.entries = [];
        this.persist();
      }
      await this.load(true);
      logger.info('worldbook', '世界书已删除', { name });
      return true;
    } catch (e) {
      this.lastWriteError = e instanceof Error ? e.message : String(e);
      logger.warn('worldbook', '删除世界书异常', e);
      return false;
    } finally {
      this.writing = false;
    }
  }

  /** 重命名世界书（后端要求同时提交 data，故先取回原书内容）。 */
  async renameWorld(oldName: string, newName: string): Promise<boolean> {
    const trimmed = newName.trim();
    if (!trimmed) {
      this.lastWriteError = '世界书名字不能为空';
      return false;
    }
    if (trimmed === oldName) return true;
    this.writing = true;
    this.lastWriteError = null;
    try {
      // 取回当前条目（激活书直接用内存，否则先拉一次）
      let data: unknown;
      if (this.activeName === oldName) {
        data = toWorldbookData(this.entries, oldName);
      } else {
        const res = await fetch(`${getBaseUrl()}/api/worldinfo/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: oldName }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          this.lastWriteError = this.readWriteError(res.status);
          return false;
        }
        data = await res.json();
      }

      const res = await this.postWrite('/api/worldinfo/rename', {
        oldName,
        newName: trimmed,
        data,
      });
      if (!res.ok) {
        this.lastWriteError = this.readWriteError(res.status);
        logger.warn('worldbook', '重命名世界书失败', { oldName, newName: trimmed, status: res.status });
        return false;
      }
      const wasActive = this.activeName === oldName;
      await this.load(true);
      if (wasActive) await this.select(trimmed);
      logger.info('worldbook', '世界书已重命名', { oldName, newName: trimmed });
      return true;
    } catch (e) {
      this.lastWriteError = e instanceof Error ? e.message : String(e);
      logger.warn('worldbook', '重命名世界书异常', e);
      return false;
    } finally {
      this.writing = false;
    }
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ activeName: this.activeName }));
    } catch {
      /* 静默 */
    }
  }

  reset() {
    this.list = [];
    this.activeName = null;
    this.entries = [];
    this.loaded = false;
    this.lastError = null;
    this.lastWriteError = null;
    this.persist();
  }
}

/**
 * 把 ST 原生世界书解析为内核条目数组。
 *
 * ST 的 `entries` 是**对象字典**（键为序号字符串），不是数组；且字段可能缺失。
 * 这里只做结构转换，**字段校验交给内核的 normalizeEntries**（单一职责）。
 */
export function parseWorldbook(book: unknown): WorldInfoEntry[] {
  const raw = (book as { entries?: unknown })?.entries;
  if (!raw) return [];

  // 兼容两种形态：对象字典（ST 原生）/ 数组（部分导出工具）
  const items: RawEntry[] = Array.isArray(raw)
    ? (raw as RawEntry[])
    : Object.values(raw as Record<string, RawEntry>);

  let fallbackUid = 0;
  return normalizeEntries(
    items
      .filter((e): e is RawEntry => !!e && typeof e === 'object')
      .map((e) => ({
        // uid 缺失时补一个（内核按 uid 建簇映射，缺失会导致簇成员错乱）
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
 * 反向转换：把内核条目数组还原为 ST 原生世界书形态（`parseWorldbook` 的逆）。
 *
 * ── 为什么要 re-index ──────────────────────────────────────────────────────
 * ST 的 `entries` 是**以序号字符串为键的对象**，且 `uid` 与该键一一对应。
 * 内核条目可能因导入/新建出现 uid 缺失或重复（`parseWorldbook` 的 fallbackUid
 * 可能与已有 uid 撞车），若直接用 uid 作键会覆盖同键条目（静默丢数据）。
 * 因此写回时**按数组下标重新编号**，同时把 `uid` 同步写下标 —— 保证
 * 「键 ↔ uid」严格一致且唯一，二次读取可无损还原（round-trip）。
 *
 * 字段名回到 ST 原生（key / content / comment / constant / disable …），
 * 仅填写有值的字段，避免写出一堆 undefined 污染文件。
 */
export function toWorldbookData(
  entries: WorldInfoEntry[],
  name: string,
): { entries: Record<string, RawEntry>; name: string } {
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
    // 保留 SSA 扩展命名空间（static / clusterId）及其它未知字段，保证可回退
    if (e.extensions && Object.keys(e.extensions).length > 0) raw.extensions = e.extensions;
    out[String(i)] = raw;
  });
  return { entries: out, name };
}

export const worldbook = new WorldbookStore();
