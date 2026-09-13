<script lang="ts">
  /**
   * 设置行项（Tavo 风格）：左标题 / 右当前值 / chevron。
   * 三种形态：link（进子页）/ toggle（开关）/ value（只读展示）。
   */
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    /** 右侧次要文本（当前值） */
    value?: string;
    /** 副标题（可选，说明用途） */
    desc?: string;
    /** link 形态：点击回调 */
    onclick?: () => void;
    /** toggle 形态：开关状态 */
    checked?: boolean;
    /** 形态 */
    kind?: 'link' | 'toggle' | 'static';
    /** toggle 变更回调 */
    onchange?: (v: boolean) => void;
    /** 自定义右侧内容 */
    trailing?: Snippet;
    /** 上下布局：标题/说明在上，控件在下（窄屏防横向挤压，默认关，不影响其它设置页） */
    stacked?: boolean;
  }

  let {
    label,
    value,
    desc,
    onclick,
    checked = false,
    kind = 'link',
    onchange,
    trailing,
    stacked = false,
  }: Props = $props();

  /**
   * 只有「真的会跳转」的行才渲染成 button。
   * 带行内输入框的行若包在 button 里，会产生 interactive 嵌套（非法 HTML，
   * 且点击输入框可能误触发跳转），因此降级为静态行。
   */
  const isLink = $derived(kind === 'link' && !!onclick);
  const showChevron = $derived(isLink && !trailing);
</script>

{#if isLink}
  <button class="row row-link" class:stacked {onclick}>
    <span class="text">
      <span class="label">{label}</span>
      {#if desc}<span class="desc">{desc}</span>{/if}
    </span>
    <span class="trail">
      {#if trailing}{@render trailing()}
      {:else if value}<span class="value">{value}</span>{/if}
      {#if showChevron}
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
      {/if}
    </span>
  </button>
{:else if kind === 'toggle'}
  <div class="row" class:stacked>
    <span class="text">
      <span class="label">{label}</span>
      {#if desc}<span class="desc">{desc}</span>{/if}
    </span>
    <button
      class="switch"
      class:on={checked}
      onclick={() => onchange?.(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span class="knob"></span>
    </button>
  </div>
{:else}
  <div class="row" class:stacked>
    <span class="text">
      <span class="label">{label}</span>
      {#if desc}<span class="desc">{desc}</span>{/if}
    </span>
    <span class="trail">
      {#if trailing}{@render trailing()}
      {:else if value}<span class="value">{value}</span>{/if}
    </span>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-md);
    width: 100%;
    padding: 15px var(--gap-lg);
    background: transparent;
    border: none;
    font-family: inherit;
    text-align: left;
    min-height: 54px;
    box-sizing: border-box;
  }
  .row-link {
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .row-link:hover {
    background: var(--neutral-1);
  }
  .row-link:active {
    background: var(--neutral-2);
  }

  /* 上下布局（stacked）：文本独占一行、控件整行铺满，避免窄屏横向挤压重叠 */
  .row.stacked {
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 8px;
  }
  .row.stacked .text {
    flex: none;
  }
  .row.stacked .trail {
    width: 100%;
    flex-wrap: wrap;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .label {
    font-size: 0.92rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.3;
  }
  .desc {
    font-size: 0.72rem;
    color: var(--text-dim);
    line-height: 1.4;
  }

  .trail {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    min-width: 0;
  }
  .value {
    font-size: 0.82rem;
    color: var(--text-dim);
    max-width: 46vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: var(--text-faint);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }

  .switch {
    width: 48px;
    height: 28px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--neutral-3);
    background: var(--neutral-2);
    position: relative;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
    flex-shrink: 0;
  }
  .switch.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #ffffff;
    transition: left var(--dur-fast) var(--ease-standard);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  }
  .switch.on .knob {
    left: 23px;
  }
</style>
