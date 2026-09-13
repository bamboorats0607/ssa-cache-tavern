/**
 * 对话背景 store —— 「角色头像（默认）」/「自定义图片或短视频」二选一。
 *
 * ── 为什么只存文件名，不存媒体本体 ──────────────────────────────────────
 * 项目全程禁用浏览器数据库（IndexedDB / SQLite / WASM），只剩 localStorage（约 5MB）。
 * 一张背景图 / 一段短视频必然撑爆配额，且 setItem 抛异常会连带丢掉整份设置。
 * 因此用户选的媒体走**后端上传**（POST /api/backgrounds/upload），
 * 这里只持久化后端返回的**文件名**，取用经 characterBackgroundUrl() 绝对化。
 *
 * ── 兜底 ────────────────────────────────────────────────────────────────
 * `mode==='custom'` 但文件名缺失，或自定义媒体加载失败时，App.svelte 会回落到
 * 角色头像。`degraded` 是**瞬时**标记（不持久化），供设置页提示用户。
 */

import { logger } from '../lib/logger';

const KEY = 'tavern.background';

export type BackgroundMode = 'auto' | 'custom';
export type BackgroundMediaType = 'image' | 'video';

export interface BackgroundState {
  /** auto = 当前角色头像全图；custom = 用户上传的媒体 */
  mode: BackgroundMode;
  /** 后端 backgrounds/ 目录下的文件名（custom 时有效） */
  file: string | null;
  /** 自定义媒体的类型，决定用 <img> 还是 <video> 渲染 */
  mediaType: BackgroundMediaType;
  /** 压暗罩强度 0–100（0 = 不压暗，100 = 最暗）；中性黑，不改变媒体色相 */
  dim: number;
}

export const DEFAULT_BACKGROUND: BackgroundState = {
  mode: 'auto',
  file: null,
  mediaType: 'image',
  dim: 42,
};

function load(): BackgroundState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_BACKGROUND };
    const parsed = JSON.parse(raw) as Partial<BackgroundState>;
    const merged = { ...DEFAULT_BACKGROUND, ...parsed };
    // 防御脏数据：custom 但没有文件名 → 视为 auto
    if (merged.mode === 'custom' && !merged.file) merged.mode = 'auto';
    return merged;
  } catch {
    return { ...DEFAULT_BACKGROUND };
  }
}

class BackgroundStore {
  state = $state<BackgroundState>({ ...DEFAULT_BACKGROUND });

  /** 自定义媒体加载失败、已回落到头像（瞬时状态，不持久化） */
  degraded = $state(false);

  constructor() {
    this.state = load();
  }

  get<K extends keyof BackgroundState>(key: K): BackgroundState[K] {
    return this.state[key];
  }

  /** 更新单个字段（统一持久化）。 */
  set<K extends keyof BackgroundState>(key: K, value: BackgroundState[K]) {
    this.state[key] = value;
    this.persist();
    logger.debug('background', `${String(key)} = ${String(value)}`);
  }

  /** 选用自定义媒体（上传成功后调用）。 */
  useCustom(file: string, mediaType: BackgroundMediaType) {
    this.state.mode = 'custom';
    this.state.file = file;
    this.state.mediaType = mediaType;
    this.degraded = false;
    this.persist();
    logger.info('background', '已切换自定义背景', { file, mediaType });
  }

  /** 恢复默认（当前角色头像全图）。 */
  useAuto() {
    this.state.mode = 'auto';
    this.state.file = null;
    this.state.mediaType = 'image';
    this.degraded = false;
    this.persist();
    logger.info('background', '已恢复默认背景（角色头像）');
  }

  /** 标记/清除「自定义媒体加载失败已回落」。 */
  markDegraded(v: boolean) {
    this.degraded = v;
  }

  persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* 静默 */
    }
  }
}

export const background = new BackgroundStore();
