<script lang="ts">
  /**
   * 多行文本设置项（行内放不下的大段内容，如故事串接 / 系统提示 / 身份描述）。
   *
   * 形态：标题 + 说明在上，整宽文本域在下 —— 与 Tavo 的长文本编辑一致。
   */
  interface Props {
    label: string;
    desc?: string;
    value: string;
    placeholder?: string;
    rows?: number;
    onchange: (v: string) => void;
  }
  let { label, desc, value, placeholder, rows = 3, onchange }: Props = $props();
</script>

<div class="block">
  <div class="head">
    <span class="label">{label}</span>
    {#if desc}<span class="desc">{desc}</span>{/if}
  </div>
  <textarea
    class="area"
    {rows}
    {placeholder}
    {value}
    onchange={(e) => onchange(e.currentTarget.value)}
  ></textarea>
</div>

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: 14px var(--gap-lg);
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .label {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text);
  }
  .desc {
    font-size: 0.7rem;
    color: var(--text-dim);
    line-height: 1.4;
  }
  .area {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    line-height: 1.6;
    resize: vertical;
    outline: none;
  }
  .area:focus {
    border-color: var(--accent-border);
  }
</style>
