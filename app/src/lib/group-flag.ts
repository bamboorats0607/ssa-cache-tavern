/**
 * 群聊功能开关（**真实承载物**，spec T0.2）。// [SSA-GROUP]
 *
 * ── 设计取舍 ──────────────────────────────────────────────────────────────
 * · **默认 false**：群聊是新增能力，未验证前不得改变既有单角色行为。
 * · **不新建 flag 框架**（spec 明令）：只有一个布尔 + 读写两个函数，
 *   持久化范式沿用 `stores/context.svelte.ts` 的 load/persist 写法
 *   （缺省合并 + try/catch 静默），但不复用它的 `tavern.ctx` 键 ——
 *   那个键是 SSA 配置本身，混入无关字段会污染配置并可能被送进 assembler。
 * · **非浏览器环境（Node 单测）恒返回 false**：这让「flag 关闭 → 群分支不进入」
 *   这条门禁可以在纯 Node 里断言，不必起浏览器。
 */

const KEY = 'tavern.group.enabled';

/**
 * 群聊是否启用。
 * Node / 隐私模式 / localStorage 不可用时**一律 false**（保守关闭）。
 */
export function isGroupChatEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** 写入开关（失败静默：开关写不进去时仍保持「关」，不影响既有功能）。 */
export function setGroupChatEnabled(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* 静默 */
  }
}

/**
 * 门禁辅助（**纯函数**）：把「flag + 群上下文」合成为组装入参。
 * flag 关闭时一律返回 `undefined` —— 即群分支不进入。
 *
 * 抽出来的理由：这条规则要能被 Node 直接断言，且调用侧只有**一个**写法，
 * 避免各调用点各写一遍 `enabled ? x : undefined` 而漏掉某处。
 */
export function gatedGroupContext<T>(enabled: boolean, group: T | undefined): T | undefined {
  return enabled ? group : undefined;
}
