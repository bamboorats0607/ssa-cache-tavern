<script lang="ts">
  /**
   * 设置子页外壳（Tavo 风格）。
   *
   * 统一承担：返回栏 + 可滚动内容区。各子页只写内容，不重复实现头部样式，
   * 保证所有子页返回手势/间距/滚动行为完全一致。
   */
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    onBack: () => void;
    children: Snippet;
  }
  let { title, onBack, children }: Props = $props();
</script>

<div class="subpage">
  <header class="bar">
    <button class="back" onclick={onBack} aria-label="返回">
      <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>
    </button>
    <h1>{title}</h1>
    <span class="spacer"></span>
  </header>
  <div class="body">
    {@render children()}
  </div>
</div>

<style>
  .subpage {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: var(--gap-md);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    flex-shrink: 0;
  }
  .back {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
    color: var(--text-muted);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .back svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .back:active {
    transform: scale(0.94);
  }
  .bar h1 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
    flex: 1;
  }
  .spacer {
    width: 36px;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    min-height: 0;
    padding-bottom: var(--gap-lg);
  }
</style>
