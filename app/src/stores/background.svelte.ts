/**
 * 对话背景 store —— **按角色**存「自定义图片 / 短视频」，默认回落到该角色头像。
 *
 * ── 为什么必须按角色（勿改回全局单例）──────────────────────────────────
 * 背景是**单个角色的立绘**，不是全局通用设置：给 A 角色选了一段视频，
 * 切到 B 角色时必须看到 B 的立绘（B 自己的自定义背景，或 B 的头像），
 * 而不是沿用 A 的。全局单例会让「选过的媒体出现在所有角色身上」。
 *
 * 归属键 = **角色头像文件名**（后端 `avatar_url`，如 `default_Seraphina.png`）：
 *  · 它是后端角色卡的**稳定标识**（edit/delete 都用它），且默认背景本来就是
 *    `characters/<avatar>`，两者同键、语义一致；
 *  · 比显示名稳定：改角色显示名不会丢绑定（会话以显示名为键，改名的代价已知）。
 *
 * ── 为什么只存文件名，不存媒体本体 ──────────────────────────────────────
 * 项目全程禁用浏览器数据库（IndexedDB / SQLite / WASM），只剩 localStorage（约 5MB）。
 * 一张背景图 / 一段短视频必然撑爆配额，且 setItem 抛异常会连带丢掉整份设置。
 * 因此用户选的媒体走后端上传（POST /api/backgrounds/upload），
 * 这里只持久化后端返回的**文件名**，取用经 characterBackgroundUrl() 绝对化。
 *
 * ── 兜底 ────────────────────────────────────────────────────────────────
 * `mode==='custom'` 但文件名缺失，或自定义媒体加载失败时，App.svelte 会回落到
 * **该角色**的头像。`degraded` 是**瞬时**标记（不持久化），供设置页提示用户。
 */

import { logger } from '../lib/logger';

const KEY = 'tavern.background';

export type BackgroundMode = 'auto' | 'custom';
export type BackgroundMediaType = 'image' | 'video';

/** 单个角色的背景设置。 */
export interface CharacterBackground {
  /** auto = 该角色头像全图；custom = 该角色专用的自定义媒体 */
  mode: BackgroundMode;
  /** 后端 backgrounds/ 目录下的文件名（custom 时有效） */
  file: string | null;
  /** 自定义媒体的类型，决定用 <img> 还是 <video> 渲染 */
  mediaType: BackgroundMediaType;
}

export interface BackgroundState {
  /** 压暗罩强度 0–100（0 = 不压暗）；中性黑，属全局显示偏好，与角色无关 */
  dim: number;
  /** 按角色（键 = 头像文件名）存的自定义背景；无记录的键视为 auto */
  perCharacter: Record<string, CharacterBackground>;
}

/** 无自定义记录时的默认：用该角色头像。 */
export const AUTO_BACKGROUND: CharacterBackground = {
  mode: 'auto',
  file: null,
  mediaType: 'image',
};

export const DEFAULT_DIM = 42;

const DEFAULT_STATE: BackgroundState = { dim: DEFAULT_DIM, perCharacter: {} };

/** 校验并归一化单条记录；非法则回落到 auto（防御脏数据）。 */
function normalizeEntry(v: unknown): CharacterBackground {
  if (!v || typeof v !== 'object') return { ...AUTO_BACKGROUND };
  const o = v as Partial<CharacterBackground>;
  const mediaType: BackgroundMediaType = o.mediaType === 'video' ? 'video' : 'image';
  if (o.mode === 'custom' && typeof o.file === 'string' && o.file) {
    return { mode: 'custom', file: o.file, mediaType };
  }
  return { ...AUTO_BACKGROUND };
}

function load(): BackgroundState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE, perCharacter: {} };
    const parsed = JSON.parse(raw) as Partial<BackgroundState> & Partial<CharacterBackground>;
    const dim = typeof parsed.dim === 'number' ? parsed.dim : DEFAULT_DIM;
    const perCharacter: Record<string, CharacterBackground> = {};
    if (parsed.perCharacter && typeof parsed.perCharacter === 'object') {
      for (const [k, v] of Object.entries(parsed.perCharacter)) {
        if (k) perCharacter[k] = normalizeEntry(v);
      }
    }
    // 旧版是「全局单一背景」({mode,file,mediaType,dim})：无法归因到具体角色，
    // 因此**只保留 dim**，媒体一律回到各角色头像 —— 不猜、也不静默套用到某个角色。
    return { dim, perCharacter };
  } catch {
    return { ...DEFAULT_STATE, perCharacter: {} };
  }
}

class BackgroundStore {
  state = $state<BackgroundState>({ ...DEFAULT_STATE, perCharacter: {} });

  /** 自定义媒体加载失败、已回落到该角色头像（瞬时状态，不持久化） */
  degraded = $state(false);

  constructor() {
    this.state = load();
  }

  /** 压暗罩强度（全局显示偏好）。 */
  get dim(): number {
    return this.state.dim;
  }

  /**
   * 取某角色生效的背景设置。
   * @param key 角色头像文件名；为空（未选到角色）时恒为 auto
   */
  forCharacter(key?: string | null): CharacterBackground {
    if (!key) return { ...AUTO_BACKGROUND };
    return this.state.perCharacter[key] ?? { ...AUTO_BACKGROUND };
  }

  /** 设置压暗强度。 */
  setDim(value: number) {
    this.state.dim = value;
    this.persist();
    logger.debug('background', `dim = ${value}`);
  }

  /** 给某角色选用自定义媒体（上传成功后调用）。 */
  useCustom(key: string, file: string, mediaType: BackgroundMediaType) {
    if (!key) return;
    // 整体替换对象而非改嵌套字段：不依赖深层代理的删除/赋值语义，可读性也更好
    this.state.perCharacter = {
      ...this.state.perCharacter,
      [key]: { mode: 'custom', file, mediaType },
    };
    this.degraded = false;
    this.persist();
    logger.info('background', '已切换自定义背景', { character: key, file, mediaType });
  }

  /** 恢复某角色的默认（该角色头像）。 */
  useAuto(key: string) {
    if (!key) return;
    const next = { ...this.state.perCharacter };
    delete next[key];
    this.state.perCharacter = next;
    this.degraded = false;
    this.persist();
    logger.info('background', '已恢复默认背景（角色头像）', { character: key });
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
