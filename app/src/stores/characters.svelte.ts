/**
 * 角色 store（跨页面共享）。
 *
 * 为什么需要独立 store：
 *   聊天页与「角色」页都需要读同一份角色列表与当前选择。
 *   若各自持有一份 state，切换角色后另一页不会同步（旧实现的问题）。
 */

import {
  fetchCharacters,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  fetchCharacterDetail,
  type CharacterCard,
  type CharacterDetail,
  type CharacterInput,
  type CharacterPreserve,
} from '../lib/backend';
import { logger } from '../lib/logger';

class CharacterStore {
  /** 角色列表 */
  list = $state<CharacterCard[]>([]);
  /** 当前选中的角色 */
  active = $state<CharacterCard | null>(null);
  /** 是否已加载过（避免重复拉取） */
  loaded = $state(false);
  /** 最近一次写操作（新建/编辑/删除）的失败原因，供 UI 展示；成功后清空 */
  lastError = $state<string | null>(null);

  async load(force = false) {
    if (this.loaded && !force) return;
    this.list = await fetchCharacters();
    this.loaded = true;
    // 若当前选中项已不存在，清空选择
    if (this.active && !this.list.some((c) => c.name === this.active?.name)) {
      this.active = null;
    }
    logger.debug('characters', '角色列表已加载', { count: this.list.length });
  }

  select(c: CharacterCard | null) {
    this.active = c;
    logger.info('characters', c ? `切换角色 → ${c.name}` : '清空角色选择');
  }

  /** 未选择时回退到第一个角色（仅用于展示，不隐式改变用户选择）。 */
  get fallback(): CharacterCard | null {
    return this.active ?? this.list[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // 写操作（新建 / 编辑 / 删除）
  //
  // 后端端点见 backend.ts；失败一律写入 lastError 并返回 false，
  // 不抛异常、不白屏。降级后端无这些端点（404/405）时同样优雅失败。
  // -------------------------------------------------------------------------

  /** 按角色名取内部文件名（avatar_url）；找不到返回 null。 */
  private avatarOf(name: string): string | null {
    const hit = this.list.find((c) => c.name === name);
    return hit?.avatar ?? null;
  }

  /**
   * 新建角色卡。成功后刷新列表并把新建项设为当前选择。
   * @returns 是否成功
   */
  async create(input: CharacterInput): Promise<boolean> {
    const name = input.name.trim();
    if (!name) {
      this.lastError = '角色名不能为空';
      return false;
    }
    this.lastError = null;
    const res = await createCharacter({ ...input, name });
    if (!res.ok) {
      this.lastError = res.error ?? '创建失败';
      return false;
    }
    await this.load(true);
    // 新建成功 → 选中它（后端可能对名字做规范化，按 name 匹配）
    this.active = this.list.find((c) => c.name === name) ?? this.active;
    logger.info('characters', '角色已创建', { name });
    return true;
  }

  /**
   * 编辑角色卡。先按角色名定位内部文件名，再提交。
   * @param name 原角色名（用于定位 avatar_url）
   * @param input 新的字段值
   * @param preserve `/get` 拿到的非表单字段（json_data / talkativeness / fav / create_date / chat）。
   *                 **必须传**，否则后端会用缺省值覆盖它们，静默清空世界书绑定、收藏标记等。
   */
  async update(name: string, input: CharacterInput, preserve?: CharacterPreserve): Promise<boolean> {
    const avatarUrl = this.avatarOf(name);
    if (!avatarUrl) {
      this.lastError = '找不到该角色（列表可能已过期，请刷新）';
      return false;
    }
    const newName = input.name.trim();
    if (!newName) {
      this.lastError = '角色名不能为空';
      return false;
    }
    this.lastError = null;
    const res = await updateCharacter(avatarUrl, { ...input, name: newName }, undefined, preserve);
    if (!res.ok) {
      this.lastError = res.error ?? '保存失败';
      return false;
    }
    await this.load(true);
    // 名字可能已改：优先按新名字匹配，否则保持原选择
    this.active =
      this.list.find((c) => c.name === newName) ??
      this.list.find((c) => c.name === name) ??
      this.active;
    logger.info('characters', '角色已保存', { from: name, to: newName });
    return true;
  }

  /**
   * 删除角色卡（连带其会话由后端处理）。若删的是当前选择则清空。
   * @param name 角色名
   */
  async remove(name: string): Promise<boolean> {
    const avatarUrl = this.avatarOf(name);
    if (!avatarUrl) {
      this.lastError = '找不到该角色（列表可能已过期，请刷新）';
      return false;
    }
    this.lastError = null;
    const res = await deleteCharacter(avatarUrl);
    if (!res.ok) {
      this.lastError = res.error ?? '删除失败';
      return false;
    }
    if (this.active?.name === name) this.active = null;
    await this.load(true);
    logger.info('characters', '角色已删除', { name });
    return true;
  }

  /**
   * 拉取单张角色卡的完整字段（编辑表单预填用）。
   * 失败时返回 null，由 UI 回退为「仅列表已有字段」。
   */
  async detail(avatarUrl: string): Promise<CharacterDetail | null> {
    return fetchCharacterDetail(avatarUrl);
  }
}

export const characters = new CharacterStore();
