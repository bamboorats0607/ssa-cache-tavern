/**
 * 学习功能开关（**真实承载物**，spec C-13 / Phase 3）。// [SSA-LEARN]
 *
 * ── 设计取舍（逐条对齐 `lib/group-flag.ts` 的既有范式）────────────────────
 * · **默认 false**：学习是新增能力，未验证前不得改变既有单角色行为。
 * · **不新建 flag 框架**：只有一个布尔 + 读写两个函数，键名 `tavern.learning.enabled`
 *   （与 `tavern.group.enabled` 同构，互不干扰）。**不复用** `tavern.ctx`
 *   ——那是 SSA 配置本身，混入无关字段会污染配置并可能被送进 assembler。
 * · **非浏览器环境（Node 单测）恒返回 false**：让「flag 关闭 → 学习入口不出现」
 *   这条门禁可以在纯 Node 里断言，不必起浏览器。
 * · 关 flag 的语义边界（C-08）：**只门控行为分支，不门控已落盘数据**。
 *   已采纳的台账与（Phase 4 之后的）世界书条目**不会**因关 flag 而删除或复原。
 */

const KEY = 'tavern.learning.enabled';

/**
 * 学习功能是否启用。
 * Node / 隐私模式 / localStorage 不可用时**一律 false**（保守关闭）。
 */
export function isLearningEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** 写入开关（失败静默：开关写不进去时仍保持「关」，不影响既有功能）。 */
export function setLearningEnabled(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* 静默 */
  }
}

/**
 * 门禁辅助（**纯函数**）：flag 关闭时一律返回 `undefined` —— 即学习分支不进入。
 *
 * 与 `gatedGroupContext` 同构：调用侧只有**一个**写法，
 * 避免各调用点各写一遍 `enabled ? x : undefined` 而漏掉某处。
 */
export function gatedLearning<T>(enabled: boolean, value: T | undefined): T | undefined {
  return enabled ? value : undefined;
}

/** flag 键名（门禁断言用；避免测试里硬编码字符串）。 */
export const LEARNING_FLAG_KEY = KEY;
