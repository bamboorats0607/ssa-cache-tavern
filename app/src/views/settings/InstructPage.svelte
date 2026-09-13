<script lang="ts">
  /**
   * 指令模式页（Instruct Mode）。
   *
   * 字段对齐 `power_user.instruct`（power-user.js:416-443）。
   * 用途：把对话包装成「用户/助手」序列标记，适配非聊天微调的模型。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import { advanced } from '../../stores/advanced.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();
</script>

<SubPage title="指令模式" {onBack}>
  <SettingGroup>
    <SettingRow
      label="启用指令模式"
      desc="按序列标记包装对话，适配续写型模型"
      kind="toggle"
      checked={advanced.get('instructEnabled')}
      onchange={(v) => advanced.set('instructEnabled', v)}
    />
  </SettingGroup>

  {#if advanced.get('instructEnabled')}
    <SettingGroup title="序列标记">
      <SettingRow label="用户前缀">
        {#snippet trailing()}
          <Field
            kind="text"
            placeholder="### Instruction:"
            value={advanced.get('inputSequence')}
            onchange={(v) => advanced.set('inputSequence', String(v))}
          />
        {/snippet}
      </SettingRow>
      <SettingRow label="助手前缀">
        {#snippet trailing()}
          <Field
            kind="text"
            placeholder="### Response:"
            value={advanced.get('outputSequence')}
            onchange={(v) => advanced.set('outputSequence', String(v))}
          />
        {/snippet}
      </SettingRow>
      <SettingRow label="系统前缀">
        {#snippet trailing()}
          <Field
            kind="text"
            placeholder="留空"
            value={advanced.get('systemSequence')}
            onchange={(v) => advanced.set('systemSequence', String(v))}
          />
        {/snippet}
      </SettingRow>
      <SettingRow label="停止序列" desc="生成到此串即停">
        {#snippet trailing()}
          <Field
            kind="text"
            placeholder="留空"
            value={advanced.get('stopSequence')}
            onchange={(v) => advanced.set('stopSequence', String(v))}
          />
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="行为">
      <SettingRow
        label="序列换行包裹"
        desc="序列标记单独占行"
        kind="toggle"
        checked={advanced.get('wrapSequences')}
        onchange={(v) => advanced.set('wrapSequences', v)}
      />
      <SettingRow
        label="序列作停止串"
        desc="自动把序列标记加入停止条件"
        kind="toggle"
        checked={advanced.get('sequencesAsStopStrings')}
        onchange={(v) => advanced.set('sequencesAsStopStrings', v)}
      />
    </SettingGroup>
  {/if}
</SubPage>
