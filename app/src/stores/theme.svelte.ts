/**
 * 主题 store。
 *
 * 设计：主题只改 <html data-theme="...">，所有视觉差异由 CSS 变量承担。
 * 因此新增主题 = 在 tokens.css 加一段变量块 + 在此登记元数据，组件零改动。
 *
 * 持久化：localStorage（key: tavern.theme）。
 * 未知/非法值回退默认主题。
 */

export interface ThemeMeta {
  id: string;
  /** 中文名（设计芸卷命名） */
  name: string;
  /** 一句话性格描述 */
  desc: string;
  /** 主题主色，用于主题选择器的色块 */
  swatch: [string, string];
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: 'cangming',
    name: '沧溟',
    desc: '深蓝夜航，沉稳高级',
    swatch: ['#2f8fd8', '#f0c86a'],
  },
  {
    id: 'xiuyan',
    name: '岫烟',
    desc: '清透青绿，冷调水感',
    swatch: ['#00b7c7', '#fcf9e8'],
  },
  {
    id: 'qingchuan',
    name: '晴川',
    desc: '晴空暖阳，明快通透',
    swatch: ['#79bedf', '#f4dc84'],
  },
  {
    id: 'meigui',
    name: '玫瑰',
    desc: '柔粉月白，亲和温暖',
    swatch: ['#d87888', '#e8f0f2'],
  },
  {
    id: 'qinglan',
    name: '青岚',
    desc: '山野青绿，自然舒展',
    swatch: ['#73ae52', '#fbf1d7'],
  },
  {
    id: 'canglang',
    name: '沧浪',
    desc: '青蓝沧浪，清冽开阔',
    swatch: ['#00b7c7', '#b1d5c9'],
  },
] as const;

export const DEFAULT_THEME = 'cangming';
const STORAGE_KEY = 'tavern.theme';

function isValid(id: string | null): id is string {
  return !!id && THEMES.some((t) => t.id === id);
}

/**
 * 应用主题到 DOM。切换时短暂开启过渡类，避免生硬跳变。
 * 首次应用（无 previous）不加过渡，防止首屏闪一下。
 */
export function applyTheme(id: string, animate = true) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-transition');
    window.setTimeout(() => root.classList.remove('theme-transition'), 400);
  }
  root.setAttribute('data-theme', id);
}

export function loadTheme(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isValid(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 隐私模式等场景静默 */
  }
}

/** 主题状态（Svelte 5 runes）。供组件直接读写。 */
class ThemeStore {
  current = $state<string>(DEFAULT_THEME);

  constructor() {
    this.current = loadTheme();
  }

  set(id: string) {
    if (!isValid(id)) return;
    this.current = id;
    applyTheme(id);
    saveTheme(id);
  }
}

export const theme = new ThemeStore();
