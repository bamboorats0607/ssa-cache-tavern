<script lang="ts">
  /**
   * 外观页：主题 + 字号。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import ThemePicker from '../../lib/ThemePicker.svelte';
  import { advanced } from '../../stores/advanced.svelte';
  import { theme, THEMES } from '../../stores/theme.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  const currentTheme = $derived(THEMES.find((t) => t.id === theme.current)?.name ?? '—');
</script>

<SubPage title="外观" {onBack}>
  <section class="themes">
    <ThemePicker />
  </section>

  <SettingGroup title="显示">
    <SettingRow label="当前主题" value={currentTheme} />
    <SettingRow label="界面字号" desc="影响全局文字大小">
      {#snippet trailing()}
        <Field
          kind="slider"
          min={0.85}
          max={1.3}
          step={0.05}
          unit="×"
          value={advanced.get('fontScale')}
          onchange={(v) => advanced.set('fontScale', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <section class="note">
    <p>主题只改变配色变量，切换即时生效并自动记忆。</p>
  </section>
</SubPage>

<style>
  .themes {
    display: flex;
    flex-direction: column;
  }
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
</style>
