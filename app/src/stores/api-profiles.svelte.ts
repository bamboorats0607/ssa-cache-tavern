/**
 * 多套 API 配置 store。
 *
 * 背景：原先只有一套扁平配置（model.svelte.ts），实际用户常需在多个供应商 /
 * 套餐密钥间切换（百炼、Token Plan 等），且端点与密钥必须配套，无法只存一套。
 *
 * 依赖方向：本文件可 import model store；model store 不得反向 import（避免循环）。
 */

import { modelConfig } from './model.svelte';
import { normalizeApiUrl } from '../lib/api-url';
import { syncApiKey } from '../lib/secrets';
import { logger } from '../lib/logger';

const KEY = 'tavern.api.profiles';

export interface ApiProfile {
  id: string;
  /** 显示名，如「百炼」「Token Plan」 */
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
}

interface PersistShape {
  list: ApiProfile[];
  activeId: string;
}

/** 生成一个足够唯一的本地 id（无需服务端，冲突概率可忽略）。 */
function makeId(): string {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

class ApiProfilesStore {
  list = $state<ApiProfile[]>([]);
  activeId = $state<string>('');

  constructor() {
    this.load();
  }

  private load() {
    let parsed: PersistShape | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) parsed = JSON.parse(raw) as PersistShape;
    } catch {
      parsed = null;
    }

    if (parsed && Array.isArray(parsed.list) && parsed.list.length > 0) {
      this.list = parsed.list;
      this.activeId = parsed.activeId;
    } else {
      // 迁移种子：老用户已有的一套填写不丢，转成第一条「默认」配置
      const seed: ApiProfile = {
        id: makeId(),
        name: '默认',
        apiUrl: modelConfig.apiUrl,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
      };
      this.list = [seed];
      this.activeId = seed.id;
      this.persist();
    }

    // activeId 失效时回退到第一条
    if (!this.list.some((p) => p.id === this.activeId)) {
      this.activeId = this.list[0]?.id ?? '';
    }

    // 加载完成后应用一次当前配置到 model store
    this.applyActive();
  }

  get active(): ApiProfile | null {
    return this.list.find((p) => p.id === this.activeId) ?? null;
  }

  /**
   * 把 active 的端点/密钥/模型写到 model store（不落盘，由调用方决定是否 persist）。
   *
   * 这里是所有「当前配置变更」的唯一漏斗：编辑、切换、删除都会经过。
   * 密钥必须同时写进后端密钥库——上游 custom 分支只从那里读（见 lib/secrets.ts）。
   */
  private applyActive() {
    const p = this.active;
    if (!p) return;
    modelConfig.apiUrl = p.apiUrl;
    modelConfig.apiKey = p.apiKey;
    modelConfig.model = p.model;
    void syncApiKey(p.apiKey);
  }

  /**
   * 新增一条配置并返回它。**不自动切换** activeId，避免打断当前会话。
   */
  add(patch?: Partial<ApiProfile>): ApiProfile {
    const item: ApiProfile = {
      id: makeId(),
      name: patch?.name ?? `配置 ${this.list.length + 1}`,
      apiUrl: normalizeApiUrl(patch?.apiUrl ?? ''),
      apiKey: patch?.apiKey ?? '',
      model: patch?.model ?? '',
    };
    this.list = [...this.list, item];
    this.persist();
    return item;
  }

  /**
   * 更新指定配置；若更新的是当前生效项，同步写入 model store 并落盘。
   */
  update(id: string, patch: Partial<ApiProfile>) {
    const idx = this.list.findIndex((p) => p.id === id);
    if (idx < 0) return;

    const merged: ApiProfile = { ...this.list[idx], ...patch };
    if (patch.apiUrl !== undefined) merged.apiUrl = normalizeApiUrl(patch.apiUrl);

    this.list = this.list.map((p) => (p.id === id ? merged : p));
    this.persist();

    if (id === this.activeId) {
      this.applyActive();
      modelConfig.persist();
    }
  }

  /** 删除配置；若删的是当前生效项，回退到剩余第一条（无剩余则清空）。 */
  remove(id: string) {
    this.list = this.list.filter((p) => p.id !== id);

    if (id === this.activeId) {
      this.activeId = this.list[0]?.id ?? '';
      this.applyActive();
      modelConfig.persist();
    }
    this.persist();
  }

  /** 切换到指定配置：写入 model store 并落盘，再持久化本 store。 */
  activate(id: string) {
    if (!this.list.some((p) => p.id === id)) return;
    this.activeId = id;
    this.applyActive();
    modelConfig.persist();
    this.persist();
    logger.info('api-profiles', `切换到配置 ${id}`);
  }

  persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ list: this.list, activeId: this.activeId }));
    } catch {
      /* 静默 */
    }
  }
}

export const apiProfiles = new ApiProfilesStore();
