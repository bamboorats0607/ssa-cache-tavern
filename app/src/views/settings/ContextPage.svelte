<script lang="ts">
  /**
   * 上下文策略页。
   *
   * 双轨保留（用户明确要求）：
   *   原版逐条注入（A） 与 骨架-活簇双层（M） 同时存在，可切换。
   * 压缩（MC）为独立开关，含压缩因数。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import { ctxConfig } from '../../stores/context.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  const STRATEGIES = [
    {
      id: 'auto' as const,
      name: '原版逐条注入',
      tag: 'A',
      desc: '社区世界书默认行为，按关键词命中即注入',
    },
    {
      id: 'sl' as const,
      name: '骨架-活簇双层',
      tag: 'M',
      desc: '静态设定冻结在前缀，动态细节按需注入尾缀',
    },
  ];
</script>

<SubPage title="上下文策略" {onBack}>
  <SettingGroup title="注入策略">
    {#each STRATEGIES as s (s.id)}
      <button
        class="strategy"
        class:selected={ctxConfig.strategy === s.id}
        onclick={() => ctxConfig.setStrategy(s.id)}
      >
        <span class="tag">{s.tag}</span>
        <span class="text">
          <span class="name">{s.name}</span>
          <span class="desc">{s.desc}</span>
        </span>
        {#if ctxConfig.strategy === s.id}
          <span class="check" aria-hidden="true">✓</span>
        {/if}
      </button>
    {/each}
  </SettingGroup>

  <p class="tip">
    两种机制<b>同时保留</b>，随时可切回原版。社区世界书在 M 策略下会自动分层，
    无需手工改造。
  </p>

  {#if ctxConfig.strategy === 'sl'}
    <SettingGroup title="装配组件">
      <SettingRow
        label="活簇世界书"
        desc="自动把原版世界书转换为分层结构"
        kind="toggle"
        checked={ctxConfig.liveClusterWorldbook}
        onchange={(v) => ctxConfig.set('liveClusterWorldbook', v)}
      />
      <SettingRow
        label="事实槽"
        desc="提取实体稳定事实，冻结后常驻前缀"
        kind="toggle"
        checked={ctxConfig.factSlot}
        onchange={(v) => ctxConfig.set('factSlot', v)}
      />
      <SettingRow
        label="检索记忆"
        desc="按当前话题检索历史相关片段"
        kind="toggle"
        checked={ctxConfig.retrievalLeaf}
        onchange={(v) => ctxConfig.set('retrievalLeaf', v)}
      />
    </SettingGroup>

    <SettingGroup title="预算分配">
      <SettingRow label="骨架区预算" desc="占模型上下文的百分比">
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="5"
            max="80"
            value={ctxConfig.skeletonBudgetPct}
            onchange={(e) =>
              ctxConfig.setNumber('skeletonBudgetPct', Number(e.currentTarget.value))}
          />
          <span class="unit">%</span>
        {/snippet}
      </SettingRow>
      <SettingRow label="活簇区预算" desc="占模型上下文的百分比">
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="5"
            max="90"
            value={ctxConfig.liveBudgetPct}
            onchange={(e) =>
              ctxConfig.setNumber('liveBudgetPct', Number(e.currentTarget.value))}
          />
          <span class="unit">%</span>
        {/snippet}
      </SettingRow>
      <SettingRow label="骨架冻结窗" desc="会话内骨架字节冻结的轮数">
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="2"
            max="20"
            value={ctxConfig.skeletonWindowRounds}
            onchange={(e) =>
              ctxConfig.setNumber('skeletonWindowRounds', Number(e.currentTarget.value))}
          />
          <span class="unit">轮</span>
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="尾缀预算">
      <SettingRow label="事实槽上限">
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="50"
            step="50"
            value={ctxConfig.factSlotMaxTokens}
            onchange={(e) =>
              ctxConfig.setNumber('factSlotMaxTokens', Number(e.currentTarget.value))}
          />
          <span class="unit">token</span>
        {/snippet}
      </SettingRow>
      <SettingRow label="检索叶上限">
        {#snippet trailing()}
          <input
            class="num"
            type="number"
            min="50"
            step="50"
            value={ctxConfig.retrievalLeafTokens}
            onchange={(e) =>
              ctxConfig.setNumber('retrievalLeafTokens', Number(e.currentTarget.value))}
          />
          <span class="unit">token</span>
        {/snippet}
      </SettingRow>
    </SettingGroup>
  {/if}
</SubPage>

<style>
  .strategy {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    width: 100%;
    padding: 15px var(--gap-lg);
    background: transparent;
    border: none;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
    min-height: 62px;
    box-sizing: border-box;
  }
  .strategy:hover {
    background: var(--neutral-1);
  }
  .strategy.selected {
    background: var(--accent-soft);
  }
  .tag {
    width: 30px;
    height: 30px;
    border-radius: var(--radius-md);
    display: grid;
    place-items: center;
    background: var(--neutral-2);
    color: var(--text-muted);
    font-weight: 800;
    font-size: 0.85rem;
    flex-shrink: 0;
  }
  .strategy.selected .tag {
    background: var(--accent);
    color: var(--on-accent);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: 0.92rem;
    font-weight: 600;
  }
  .desc {
    font-size: 0.72rem;
    color: var(--text-dim);
    line-height: 1.4;
  }
  .check {
    color: var(--accent);
    font-weight: 800;
    flex-shrink: 0;
  }

  .tip {
    margin: 0;
    padding: 0 4px;
    font-size: 0.72rem;
    color: var(--text-dim);
    line-height: 1.55;
  }
  .tip b {
    color: var(--text-muted);
  }

  .num {
    width: 62px;
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
</style>
