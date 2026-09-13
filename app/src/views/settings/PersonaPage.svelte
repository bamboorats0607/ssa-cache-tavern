<script lang="ts">
  /**
   * 用户身份页（Persona）—— power-user.js:484-494 实测字段。
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

<SubPage title="用户身份" {onBack}>
  <SettingGroup>
    <SettingRow label="显示名" desc={'替换对话中的 {{user}}'}>
      {#snippet trailing()}
        <Field
          kind="text"
          value={modelConfig.userName}
          onchange={(v) => modelConfig.set('userName', String(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <SettingGroup title="身份描述">
    <SettingText
      label="描述内容"
      desc="角色会以此认识你"
      placeholder="例如：一位云游的剑客，寡言但守信。"
      rows={4}
      value={advanced.get('personaDescription')}
      onchange={(v) => advanced.set('personaDescription', v)}
    />
  </SettingGroup>

  <SettingGroup title="注入方式">
    <SettingRow label="注入位置">
      {#snippet trailing()}
        <Field
          kind="select"
          value={advanced.get('personaPosition')}
          options={INJECT_POSITIONS}
          onchange={(v) => advanced.set('personaPosition', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="注入角色">
      {#snippet trailing()}
        <Field
          kind="select"
          value={advanced.get('personaRole')}
          options={INJECT_ROLES}
          onchange={(v) => advanced.set('personaRole', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="注入深度">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          value={advanced.get('personaDepth')}
          unit="层"
          onchange={(v) => advanced.set('personaDepth', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>
</SubPage>
