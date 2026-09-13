<script lang="ts">
  /**
   * 长记忆页。
   *
   * 选型结论（见 lib/context/memory.ts 头部论证）：
   *   摘要压缩 = 主干（时序叙事，append-only，符合红线 R3）
   *   知识图谱 = 检索增强（角色关系/实体状态，注入尾缀，不碰前缀）
   * 两者**分层共存**，不是二选一；本页把两条线的参数都暴露出来。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import SettingText from '../../lib/settings/SettingText.svelte';
  import { advanced } from '../../stores/advanced.svelte';
  import { memoryConfig } from '../../stores/context.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();
</script>

<SubPage title="长记忆" {onBack}>
  <section class="note">
    <p>
      长记忆分两层：<b>摘要</b>负责「发生了什么」的时序脉络，<b>关系索引</b>负责
      「谁和谁什么关系」的结构化回忆。前者是主干，后者在需要时补充。
    </p>
  </section>

  <SettingGroup title="摘要">
    <SettingRow
      label="启用自动摘要"
      desc="超出长度后自动压缩前情，追加式不改写历史"
      kind="toggle"
      checked={memoryConfig.summaryThreshold !== null}
      onchange={(v) => memoryConfig.setSummaryEnabled(v)}
    />
    {#if memoryConfig.summaryThreshold !== null}
      <SettingRow label="触发阈值" desc="历史超过该 token 数即生成摘要">
        {#snippet trailing()}
          <Field
            kind="number"
            min={500}
            step={500}
            value={memoryConfig.summaryThreshold ?? 4000}
            unit="token"
            onchange={(v) => memoryConfig.setNumber('summaryThreshold', Number(v))}
          />
        {/snippet}
      </SettingRow>
      <SettingRow label="摘要长度上限">
        {#snippet trailing()}
          <Field
            kind="number"
            min={100}
            step={100}
            value={memoryConfig.summaryMaxTokens}
            unit="token"
            onchange={(v) => memoryConfig.setNumber('summaryMaxTokens', Number(v))}
          />
        {/snippet}
      </SettingRow>
      <SettingRow label="摘要间隔" desc="每多少条消息重算一次">
        {#snippet trailing()}
          <Field
            kind="number"
            min={0}
            max={250}
            value={advanced.get('memoryPromptInterval')}
            unit="条"
            onchange={(v) => advanced.set('memoryPromptInterval', Number(v))}
          />
        {/snippet}
      </SettingRow>
      <SettingRow label="目标字数" desc="希望摘要压到多少字">
        {#snippet trailing()}
          <Field
            kind="number"
            min={25}
            max={1000}
            step={25}
            value={advanced.get('memoryPromptWords')}
            unit="字"
            onchange={(v) => advanced.set('memoryPromptWords', Number(v))}
          />
        {/snippet}
      </SettingRow>
    {/if}
  </SettingGroup>

  <SettingGroup title="关系索引">
    <SettingRow
      label="启用关系索引"
      desc="记录角色之间的关系与属性，用于精准回忆"
      kind="toggle"
      checked={memoryConfig.graphEnabled}
      onchange={(v) => memoryConfig.setGraphEnabled(v)}
    />
    {#if memoryConfig.graphEnabled}
      <SettingRow label="注入上限" desc="关系片段在尾缀区占用的 token">
        {#snippet trailing()}
          <Field
            kind="number"
            min={50}
            step={50}
            value={memoryConfig.graphMaxTokens}
            unit="token"
            onchange={(v) => memoryConfig.setNumber('graphMaxTokens', Number(v))}
          />
        {/snippet}
      </SettingRow>
    {/if}
  </SettingGroup>

  <SettingGroup title="行为">
    <SettingRow
      label="暂停自动总结"
      desc="临时冻结摘要，保留现有内容"
      kind="toggle"
      checked={advanced.get('memoryFrozen')}
      onchange={(v) => advanced.set('memoryFrozen', v)}
    />
    <SettingRow
      label="总结时排除世界书与作者注"
      kind="toggle"
      checked={advanced.get('memorySkipWIAN')}
      onchange={(v) => advanced.set('memorySkipWIAN', v)}
    />
    <SettingRow
      label="纳入世界书扫描"
      kind="toggle"
      checked={advanced.get('memoryScan')}
      onchange={(v) => advanced.set('memoryScan', v)}
    />
  </SettingGroup>

  <SettingGroup title="注入模板">
    <SettingText
      label="摘要模板"
      desc={'必须包含 {{summary}} 占位符'}
      placeholder={'[Summary: {{summary}}]'}
      rows={2}
      value={advanced.get('memoryPromptTemplate')}
      onchange={(v) => advanced.set('memoryPromptTemplate', v)}
    />
  </SettingGroup>
</SubPage>

<style>
  .note {
    border-radius: var(--radius-2xl);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    padding: var(--gap-lg);
  }
  .note p {
    margin: 0;
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .note b {
    color: var(--text);
  }
</style>
