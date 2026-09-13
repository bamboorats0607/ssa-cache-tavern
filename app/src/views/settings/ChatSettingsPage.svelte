<script lang="ts">
  /**
   * 聊天设置页（power-user.js:307-414 实测字段）。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import { advanced, SEND_ON_ENTER } from '../../stores/advanced.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();
</script>

<SubPage title="聊天设置" {onBack}>
  <SettingGroup title="发送">
    <SettingRow label="回车行为">
      {#snippet trailing()}
        <Field
          kind="select"
          value={advanced.get('sendOnEnter')}
          options={SEND_ON_ENTER}
          onchange={(v) => advanced.set('sendOnEnter', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <SettingGroup title="显示">
    <SettingRow
      label="流式刷新帧率"
      desc="越高越顺滑，也越费电"
    >
      {#snippet trailing()}
        <Field
          kind="number"
          min={5}
          max={100}
          step={5}
          value={advanced.get('streamingFps')}
          unit="fps"
          onchange={(v) => advanced.set('streamingFps', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow
      label="自动滚动到底部"
      kind="toggle"
      checked={advanced.get('autoScroll')}
      onchange={(v) => advanced.set('autoScroll', v)}
    />
    <SettingRow
      label="自动修正 Markdown"
      kind="toggle"
      checked={advanced.get('autoFixMarkdown')}
      onchange={(v) => advanced.set('autoFixMarkdown', v)}
    />
    <SettingRow
      label="显示消息 token 数"
      kind="toggle"
      checked={advanced.get('showTokenCount')}
      onchange={(v) => advanced.set('showTokenCount', v)}
    />
    <SettingRow
      label="显示角色名标签"
      kind="toggle"
      checked={advanced.get('allowNameDisplay')}
      onchange={(v) => advanced.set('allowNameDisplay', v)}
    />
  </SettingGroup>

  <SettingGroup title="历史">
    <SettingRow label="加载消息条数" desc="0 = 全部加载">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          max={1000}
          value={advanced.get('chatTruncation')}
          unit="条"
          onchange={(v) => advanced.set('chatTruncation', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>
</SubPage>
