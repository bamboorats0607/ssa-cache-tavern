<script lang="ts">
  /**
   * 通用输入字段（配合 SettingRow 的 trailing 插槽使用）。
   *
   * 统一 4 种行内输入形态的样式与交互，避免每个设置页重复写 input CSS：
   * text / number / slider / select。
   * 多行长文本请用 SettingText（行内放不下）。
   */
  interface Props {
    kind?: 'text' | 'number' | 'slider' | 'select';
    value: string | number;
    onchange: (v: string | number) => void;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    unit?: string;
    /** select 选项 */
    options?: readonly { value: string | number; label: string }[];
    /** 占满整行：text / select 宽度改为 100%（用于上下布局里独占一行） */
    block?: boolean;
  }

  let {
    kind = 'text',
    value,
    onchange,
    min,
    max,
    step,
    placeholder,
    unit,
    options = [],
    block = false,
  }: Props = $props();
</script>

{#if kind === 'number'}
  <input
    class="num"
    type="number"
    {min}
    {max}
    {step}
    value={value as number}
    onchange={(e) => onchange(Number(e.currentTarget.value))}
  />
  {#if unit}<span class="unit">{unit}</span>{/if}
{:else if kind === 'slider'}
  <!-- 滑动 + 精确输入二合一：拖动调粗，输入框敲精确值 -->
  <input
    class="slider"
    type="range"
    {min}
    {max}
    {step}
    value={value as number}
    oninput={(e) => onchange(Number(e.currentTarget.value))}
  />
  <input
    class="num"
    type="number"
    {min}
    {max}
    {step}
    value={value as number}
    onchange={(e) => {
      let v = Number(e.currentTarget.value);
      if (Number.isFinite(v)) {
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        onchange(v);
      }
    }}
  />
  {#if unit}<span class="unit">{unit}</span>{/if}
{:else if kind === 'select'}
  <select
    class="select"
    class:block
    value={String(value)}
    onchange={(e) => {
      const raw = e.currentTarget.value;
      const hit = options.find((o) => String(o.value) === raw);
      onchange(hit ? hit.value : raw);
    }}
  >
    {#each options as o (String(o.value))}
      <option value={String(o.value)}>{o.label}</option>
    {/each}
  </select>
{:else}
  <input
    class="txt"
    class:block
    type="text"
    {placeholder}
    value={String(value)}
    onchange={(e) => onchange(e.currentTarget.value)}
  />
  {#if unit}<span class="unit">{unit}</span>{/if}
{/if}

<style>
  .num {
    width: 72px;
    padding: 5px 8px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.85rem;
    text-align: right;
    outline: none;
  }
  .num:focus,
  .txt:focus,
  .select:focus {
    border-color: var(--accent-border);
  }
  .txt {
    width: 150px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    outline: none;
  }
  .select {
    max-width: 190px;
    padding: 6px 8px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    outline: none;
  }
  /* 占满整行：宽度铺满、去掉行内宽度上限 */
  .txt.block,
  .select.block {
    width: 100%;
    max-width: none;
    box-sizing: border-box;
  }
  .slider {
    width: 96px;
    flex: 1;
    min-width: 60px;
    max-width: 150px;
    accent-color: var(--accent);
  }
  .unit {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-left: 2px;
    flex-shrink: 0;
  }
</style>
