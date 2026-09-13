/**
 * 返回键处理注册中心。
 *
 * 背景：Android 端未安装 @capacitor/app，返回键走系统默认行为 → finish()，
 * 直接退出整个应用。这里提供一个 JS 侧的 handler 注册表，由原生通过
 * `window.__tavernHandleBack()` 逐级询问「谁来消费这次返回」。
 *
 * 原生契约（由原生工程师固定，不可改动）：
 * - 函数名：`__tavernHandleBack`
 * - 返回值：**字符串** `'true'`（JS 已消费，原生不处理）/ `'false'`（JS 未消费，
 *   原生执行退到后台而非杀进程）
 */

/** 返回处理器：返回 true 表示「已消费本次返回」，false 表示「交给下一个」 */
export type BackHandler = () => boolean;

interface Entry {
  fn: BackHandler;
  priority: number;
}

/** 已注册的 handler；priority 数值大的先执行 */
const handlers: Entry[] = [];

/** 幂等标志：桥接入口只安装一次 */
let installed = false;

/**
 * 注册一个返回 handler。
 *
 * @param fn 处理器，返回 true 消费本次返回、false 放行给下一个
 * @param priority 优先级，数值大的先执行（默认 0）
 * @returns 注销函数，组件卸载时必须调用以避免泄漏
 */
export function pushBack(fn: BackHandler, priority = 0): () => void {
  const entry: Entry = { fn, priority };
  handlers.push(entry);
  return () => {
    const i = handlers.indexOf(entry);
    if (i !== -1) handlers.splice(i, 1);
  };
}

/**
 * 把全局入口挂到 window 上（幂等，重复调用无副作用）。
 */
export function installBackBridge(): void {
  if (installed) return;
  installed = true;
  (window as unknown as { __tavernHandleBack?: () => string }).__tavernHandleBack = () => {
    // 按优先级从高到低依次询问，第一个消费掉的立即返回 'true'
    const ordered = [...handlers].sort((a, b) => b.priority - a.priority);
    for (const h of ordered) {
      if (h.fn()) return 'true';
    }
    return 'false';
  };
}
