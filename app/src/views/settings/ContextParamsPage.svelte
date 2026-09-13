<script lang="ts">
  /**
   * 上下文参数页（原版酒馆的「上下文设置 / 上下文模板」）。
   *
   * 字段对齐 `power_user.context`（power-user.js:445-455）+ 全局 token 预算
   * （script.js:931-932）。默认值取源码默认，保证与用户既有心智一致。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import SettingText from '../../lib/settings/SettingText.svelte';
  import { advanced, INJECT_POSITIONS, INJECT_ROLES } from '../../stores/advanced.svelte';
  import { modelConfig } from '../../stores/model.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();
</script>

<SubPage title="上下文参数" {onBack}>
  <SettingGroup title="预算">
    <SettingRow label="上下文上限" desc="模型可接受的最大 token 数">
      {#snippet trailing()}
        <Field
          kind="number"
          min={1024}
          step={1024}
          value={modelConfig.maxContext}
          unit="token"
          onchange={(v) => modelConfig.set('maxContext', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="回复长度上限" desc="单次生成的最大 token">
      {#snippet trailing()}
        <Field
          kind="number"
          min={16}
          step={32}
          value={modelConfig.maxTokens}
          unit="token"
          onchange={(v) => modelConfig.set('maxTokens', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="Token 计数补偿" desc="为分词器误差预留的余量">
      {#snippet trailing()}
        <Field
          kind="number"
          min={-2048}
          max={2048}
          value={advanced.get('tokenPadding')}
          onchange={(v) => advanced.set('tokenPadding', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <SettingGroup title="故事串接">
    <SettingRow label="注入位置">
      {#snippet trailing()}
        <Field
          kind="select"
          value={advanced.get('storyStringPosition')}
          options={INJECT_POSITIONS}
          onchange={(v) => advanced.set('storyStringPosition', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="注入角色">
      {#snippet trailing()}
        <Field
          kind="select"
          value={advanced.get('storyStringRole')}
          options={INJECT_ROLES}
          onchange={(v) => advanced.set('storyStringRole', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="注入深度" desc="仅「聊天内」位置生效">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          value={advanced.get('storyStringDepth')}
          unit="层"
          onchange={(v) => advanced.set('storyStringDepth', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <SettingGroup title="分隔符">
    <SettingRow label="对话示例分隔符">
      {#snippet trailing()}
        <Field
          kind="text"
          value={advanced.get('exampleSeparator')}
          onchange={(v) => advanced.set('exampleSeparator', String(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="聊天起始分隔符">
      {#snippet trailing()}
        <Field
          kind="text"
          value={advanced.get('chatStart')}
          onchange={(v) => advanced.set('chatStart', String(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <SettingGroup title="文本处理">
    <SettingRow
      label="折叠连续空行"
      kind="toggle"
      checked={advanced.get('collapseNewlines')}
      onchange={(v) => advanced.set('collapseNewlines', v)}
    />
    <SettingRow
      label="裁剪不完整句子"
      desc="避免回复截断在句中"
      kind="toggle"
      checked={advanced.get('trimSentences')}
      onchange={(v) => advanced.set('trimSentences', v)}
    />
    <SettingRow
      label="裁剪首尾空格"
      kind="toggle"
      checked={advanced.get('trimSpaces')}
      onchange={(v) => advanced.set('trimSpaces', v)}
    />
  </SettingGroup>

  <SettingGroup title="故事串接模板">
    <SettingText
      label="模板内容"
      desc="留空则使用内置默认模板（角色描述 / 人格 / 场景 / 身份）"
      placeholder={'{{#if description}}{{description}}\n{{/if}}…'}
      rows={5}
      value={advanced.get('storyString')}
      onchange={(v) => advanced.set('storyString', v)}
    />
  </SettingGroup>
</SubPage>
