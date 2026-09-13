<script lang="ts">
  /**
   * 上下文压缩页（MC 策略）。
   *
   * 「压缩因数」语义对齐业界标准（LLMLingua `rate` = 压缩后 / 压缩前），
   * 因此 0.75 = 保留 75%，正好对应实测基准的每行 36 字（48 × 0.75）。
   * 页内如实展示实测代价 —— 压缩换来不爆上下文，代价是命中率结构性下移。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import { ctxConfig } from '../../stores/context.svelte';
  import { modelConfig } from '../../stores/model.svelte';
  import { COMPACT_BASE_CHARS } from '../../lib/context/compact.ts';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  // 自动阈值：maxContext * 0.5（实测默认）
  const autoThreshold = $derived(Math.round(modelConfig.maxContext * 0.5));
  const effectiveThreshold = $derived(
    ctxConfig.compactThreshold > 0 ? ctxConfig.compactThreshold : autoThreshold,
  );

  const keepChars = $derived(Math.round(COMPACT_BASE_CHARS * ctxConfig.compactRatio));

  const ratioHint = $derived(
    ctxConfig.compactRatio >= 0.95
      ? '几乎不删（最保真）'
      : ctxConfig.compactRatio >= 0.7
        ? '标准（实测基准档）'
        : ctxConfig.compactRatio >= 0.45
          ? '压得较狠'
          : '极致压缩（质量风险高）',
  );
</script>

<SubPage title="上下文压缩" {onBack}>
  <SettingGroup>
    <SettingRow
      label="启用压缩"
      desc="长对话自动折叠旧内容，避免超出模型上限"
      kind="toggle"
      checked={ctxConfig.compactEnabled}
      onchange={(v) => ctxConfig.set('compactEnabled', v)}
    />
  </SettingGroup>

  {#if ctxConfig.compactEnabled}
    <SettingGroup title="触发条件">
      <SettingRow
        label="触发阈值"
        desc={ctxConfig.compactThreshold > 0
          ? '自定义'
          : `自动：上下文上限 × 50% = ${autoThreshold}`}
      >
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="0"
            step="256"
            value={ctxConfig.compactThreshold}
            onchange={(e) =>
              ctxConfig.setNumber('compactThreshold', Number(e.currentTarget.value))}
          />
          <span class="unit">token</span>
        {/snippet}
      </SettingRow>
      <SettingRow label="保留最近" desc="折叠时不动最近的这些消息，保住当前语境">
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="2"
            max="30"
            value={ctxConfig.compactKeep}
            onchange={(e) => ctxConfig.setNumber('compactKeep', Number(e.currentTarget.value))}
          />
          <span class="unit">条</span>
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="压缩因数">
      <SettingRow label="压缩因数" desc={`${ratioHint} · 每行约保留 ${keepChars} 字`}>
        {#snippet trailing()}
          <Field
            kind="slider"
            min={0}
            max={1}
            step={0.01}
            value={ctxConfig.compactRatio}
            onchange={(v) => ctxConfig.setNumber('compactRatio', Number(v))}
          />
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <section class="note">
      <h4>怎么理解这个因数</h4>
      <p>
        因数的定义是<b>压缩后 / 压缩前</b>（业界通用口径）。0.75 表示保留约七成五的信息，
        这也是实测的基准档；调到 1.00 保留最多，往下调压得更狠。
      </p>
      <p class="hint">
        注意：折叠本身已是大比例压缩（整条消息 → 一行），因数只调节这一行的信息密度，
        所以它<b>不是</b> token 数的精确比例。
      </p>
    </section>

    <section class="note">
      <h4>关于代价</h4>
      <p>
        压缩会把旧消息折叠为摘要块，每压缩一次缓存前缀就断裂一次。
        实测（30 轮 / 5 次压缩）命中率从 86.9% 降至 65.1%。
      </p>
      <p class="hint">
        当前阈值 <code>{effectiveThreshold}</code> token，超过即触发一次折叠。
        调大阈值 = 少压缩、更保命中，但更接近模型上限。
      </p>
    </section>
  {/if}
</SubPage>

<style>
  .num {
    width: 86px;
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
  .num:focus {
    border-color: var(--accent-border);
  }
  .unit {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-left: 2px;
  }

  .note {
    border-radius: var(--radius-2xl);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    padding: var(--gap-lg);
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
  }
  .note h4 {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text);
  }
  .note p {
    margin: 0;
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .note b {
    color: var(--text);
  }
  .note .hint {
    color: var(--text-dim);
  }
  .note code {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    background: var(--neutral-2);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
  }
</style>
