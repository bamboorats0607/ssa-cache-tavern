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
import type { WorldInfoEntry } from '../lib/context/assembler';
import { convertToLiveCluster } from '../lib/context/live-cluster-worldbook';
import { logger } from '../lib/logger';
// 纯函数已搬到 lib/context/worldbook-format.ts（Node 侧门禁可直接 import 生产代码）；
// 此处再导出，既有调用方（含 WorldbookView）import 路径不变。// [SSA-LEARN]
import { parseWorldbook, toWorldbookData } from '../lib/context/worldbook-format';
export { parseWorldbook, toWorldbookData };
export type { RawEntry, WorldbookData } from '../lib/context/worldbook-format';

const KEY = 'tavern.worldbook';

export interface WorldbookMeta {
  fileId: string;
  name: string;
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

export const worldbook = new WorldbookStore();
