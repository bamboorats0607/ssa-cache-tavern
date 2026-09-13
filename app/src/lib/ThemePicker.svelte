<script lang="ts">
  /**
   * 主题选择器：网格排列的主题卡片，含双色 swatch。
   * 选中态用主色描边 + 对勾。
   */
  import { THEMES, theme } from '../stores/theme.svelte';
</script>

<div class="theme-grid" role="radiogroup" aria-label="主题选择">
  {#each THEMES as t (t.id)}
    <button
      class="theme-card glass glass-hover"
      class:selected={theme.current === t.id}
      role="radio"
      aria-checked={theme.current === t.id}
      onclick={() => theme.set(t.id)}
      data-theme-id={t.id}
    >
      <span class="swatch" aria-hidden="true">
        <span class="swatch-a" style="background:{t.swatch[0]}"></span>
        <span class="swatch-b" style="background:{t.swatch[1]}"></span>
      </span>
      <span class="meta">
        <span class="name">{t.name}</span>
        <span class="desc">{t.desc}</span>
      </span>
      {#if theme.current === t.id}
        <span class="check" aria-hidden="true">✓</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--gap-md);
  }

  .theme-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: var(--gap-md);
    border-radius: var(--radius-xl);
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    transition: all var(--dur-fast) var(--ease-standard);
    -webkit-tap-highlight-color: transparent;
  }
  .theme-card:hover {
    transform: translateY(-2px);
  }
  .theme-card:active {
    transform: scale(0.98);
  }
  .theme-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent), 0 4px 20px var(--accent-glow);
  }

  .swatch {
    display: flex;
    height: 44px;
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--glass-border);
  }
  .swatch-a {
    flex: 2;
  }
  .swatch-b {
    flex: 1;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }
  .desc {
    font-size: 0.68rem;
    color: var(--text-dim);
    line-height: 1.4;
  }

  .check {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 12px;
    font-weight: 800;
  }
</style>
