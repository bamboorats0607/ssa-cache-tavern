<script lang="ts">
  /**
   * 模型设置页（SillyBunny 参数清单对齐）。
   *
   * 字段来源：`oai_settings`（openai.js:545-669）+ `textgenerationwebui_settings`
   * （textgen-settings.js:204-297）实测清单，默认值取源码默认。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import { modelConfig } from '../../stores/model.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  const SAMPLERS = [
    { k: 'temp' as const, label: '温度', desc: '越高越随机', min: 0, max: 2, step: 0.01 },
    { k: 'topP' as const, label: 'Top P', desc: '核采样阈值', min: 0, max: 1, step: 0.01 },
    { k: 'topK' as const, label: 'Top K', desc: '0 = 不限制', min: 0, max: 500, step: 1 },
    { k: 'minP' as const, label: 'Min P', desc: '低于阈值概率的候选剔除', min: 0, max: 1, step: 0.001 },
    { k: 'freqPen' as const, label: '频率惩罚', desc: '抑制重复用词', min: -2, max: 2, step: 0.01 },
    { k: 'presPen' as const, label: '存在惩罚', desc: '鼓励新话题', min: -2, max: 2, step: 0.01 },
    { k: 'repPen' as const, label: '重复惩罚', desc: '1.0 = 关闭', min: 1, max: 2, step: 0.01 },
  ];

  const modelName = $derived(modelConfig.model || '后端默认');
</script>

<SubPage title="模型设置" {onBack}>
  <SettingGroup title="模型">
    <SettingRow label="模型名称" desc={`当前：${modelName}`}>
      {#snippet trailing()}
        <input
          class="txt"
          type="text"
          placeholder="留空用后端默认"
          value={modelConfig.model}
          onchange={(e) => modelConfig.set('model', e.currentTarget.value)}
        />
      {/snippet}
    </SettingRow>
    <SettingRow
      label="流式输出"
      desc="逐字显示回复"
      kind="toggle"
      checked={modelConfig.stream}
      onchange={(v) => modelConfig.set('stream', v)}
    />
    <SettingRow
      label="思考模式"
      desc="关闭更快更省；开启会与正文共享输出预算，可能导致只思考不回复"
      kind="toggle"
      checked={modelConfig.thinking}
      onchange={(v) => modelConfig.set('thinking', v)}
    />
  </SettingGroup>

  <SettingGroup title="采样">
    {#each SAMPLERS as row (row.k)}
      <SettingRow label={row.label} desc={row.desc}>
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min={row.min}
            max={row.max}
            step={row.step}
            value={modelConfig[row.k]}
            onchange={(e) => modelConfig.set(row.k, Number(e.currentTarget.value))}
          />
        {/snippet}
      </SettingRow>
    {/each}
  </SettingGroup>

  <SettingGroup title="长度">
    <SettingRow label="上下文上限" desc="模型可接受的最大 token 数">
      {#snippet trailing()}
        <input
          class="num wide"
          type="number"
          min="1024"
          step="1024"
          value={modelConfig.maxContext}
          onchange={(e) => modelConfig.set('maxContext', Number(e.currentTarget.value))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="回复长度上限" desc="单次生成的最大 token">
      {#snippet trailing()}
        <input
          class="num"
          type="number"
          min="16"
          step="32"
          value={modelConfig.maxTokens}
          onchange={(e) => modelConfig.set('maxTokens', Number(e.currentTarget.value))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow
      label="随机种子"
      desc="-1 = 每次随机（固定值可复现）"
    >
      {#snippet trailing()}
        <input
          class="num wide"
          type="number"
          min="-1"
          value={modelConfig.seed}
          onchange={(e) => modelConfig.set('seed', Number(e.currentTarget.value))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <button class="reset" onclick={() => modelConfig.reset()}>恢复默认参数</button>
</SubPage>

<style>
  .num {
    width: 68px;
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
  .num.wide {
    width: 92px;
  }
  .num:focus,
  .txt:focus {
    border-color: var(--accent-border);
  }
  .txt {
    width: 148px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    outline: none;
  }

  .reset {
    padding: 13px;
    border-radius: var(--radius-2xl);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .reset:hover {
    background: var(--neutral-1);
    color: var(--text);
  }
</style>
