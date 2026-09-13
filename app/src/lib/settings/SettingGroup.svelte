<script lang="ts">
  /**
   * 通用列表设置组件（Tavo 风格）。
   *
   * 结构：分组卡片 → 行项（左标题 / 右当前值 / chevron）→ 点击进子页。
   * 与 Tavo 一致：无边框大圆角卡片、行间细分割线、右对齐次要文本。
   */
  import type { Snippet } from 'svelte';

  interface Props {
    /** 分组标题（可选） */
    title?: string;
    children: Snippet;
  }
  let { title, children }: Props = $props();
</script>

<section class="group">
  {#if title}<h3 class="group-title">{title}</h3>{/if}
  <div class="group-body">
    {@render children()}
  </div>
</section>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .group-title {
    margin: 0 0 0 4px;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }
  .group-body {
    border-radius: var(--radius-2xl);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--blur-intensity));
    border: 1px solid var(--glass-border);
    overflow: hidden;
  }
  /* 行间分割线：第 2 个孩子起加上边线（单个复合选择器，避免压缩后出现悬空组合符） */
  .group-body > :global(:nth-child(n + 2)) {
    border-top: 1px solid var(--glass-border);
  }
</style>
