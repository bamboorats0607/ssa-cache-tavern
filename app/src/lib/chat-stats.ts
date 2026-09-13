/**
 * 单轮对话的用量与组装统计。
 *
 * 独立成模块的原因：`TurnStats` 同时被 `ChatView.svelte`（写入）与
 * `MessageBubble.svelte`（渲染）使用。Svelte 单文件组件**不能导出类型**给
 * 其它模块 import，因此类型必须放在普通 `.ts` 模块里。
 */

export interface TurnStats {
  /** 输入 token（优先用 API 实测，缺失时用本地估算） */
  inputTokens: number;
  /** 输出 token */
  outputTokens: number;
  /** 输入中命中缓存的 token */
  cachedTokens: number;
  /** 输入是否来自 API 实测（false = 本地估算） */
  inputMeasured: boolean;
  /** 本轮注入的来源分解（便于排查「为什么注入了这些」） */
  breakdown: {
    /** 前缀区条目数（骨架，字节冻结） */
    prefix: number;
    /** 尾缀区条目数（每轮变化） */
    suffix: number;
    /** 本轮激活的簇数 */
    liveClusters: number;
    /** 事实槽 token */
    facts: number;
    /** 检索叶 token */
    leaf: number;
  };
}
