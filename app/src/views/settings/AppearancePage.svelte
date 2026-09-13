<script lang="ts">
  /**
   * 外观页：主题 + 字号 + 对话背景。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import ThemePicker from '../../lib/ThemePicker.svelte';
  import { advanced } from '../../stores/advanced.svelte';
  import { background } from '../../stores/background.svelte';
  import { theme, THEMES } from '../../stores/theme.svelte';
  import { uploadBackground } from '../../lib/backend';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  const currentTheme = $derived(THEMES.find((t) => t.id === theme.current)?.name ?? '—');

  // ── 对话背景 ──────────────────────────────────────────────────────────────
  // 媒体本体走后端上传，localStorage 只存文件名（见 background store 顶部说明）。
  let imageInput = $state<HTMLInputElement | null>(null);
  let videoInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);

  const isAuto = $derived(background.state.mode === 'auto');
  const isImage = $derived(background.state.mode === 'custom' && background.state.mediaType === 'image');
  const isVideo = $derived(background.state.mode === 'custom' && background.state.mediaType === 'video');

  const sourceValue = $derived.by(() => {
    if (background.state.mode === 'custom' && background.state.file) {
      const kind = background.state.mediaType === 'video' ? '视频' : '图片';
      return `${kind}：${background.state.file}`;
    }
    return '角色头像（默认）';
  });

  const sourceDesc = $derived(
    background.degraded
      ? '自定义背景加载失败，已临时回落到角色头像'
      : background.state.mode === 'custom'
        ? '加载失败时会自动回落到角色头像'
        : '把当前角色的头像全图铺满为背景',
  );

  function openPicker(kind: 'image' | 'video') {
    uploadError = null;
    (kind === 'image' ? imageInput : videoInput)?.click();
  }

  async function onPicked(e: Event, kind: 'image' | 'video') {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // 清空 value，允许用户重复选择同一个文件
    input.value = '';
    if (!file) return;
    uploading = true;
    uploadError = null;
    const res = await uploadBackground(file);
    uploading = false;
    if (!res.ok || !res.filename) {
      uploadError = res.error ?? '上传失败';
      return;
    }
    background.useCustom(res.filename, kind);
  }
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

  <SettingGroup title="对话背景">
    <SettingRow label="背景来源" value={sourceValue} desc={sourceDesc} stacked>
      {#snippet trailing()}
        <div class="bg-actions">
          <button class="btn" class:on={isAuto} onclick={() => background.useAuto()}>默认</button>
          <button class="btn" class:on={isImage} disabled={uploading} onclick={() => openPicker('image')}>
            选择图片
          </button>
          <button class="btn" class:on={isVideo} disabled={uploading} onclick={() => openPicker('video')}>
            选择视频
          </button>
          {#if !isAuto}
            <button class="btn" onclick={() => background.useAuto()}>清除</button>
          {/if}
        </div>
      {/snippet}
    </SettingRow>
    <SettingRow label="背景压暗" desc="压暗背景以突出文字；只用中性色，不改变背景本身色调" stacked>
      {#snippet trailing()}
        <Field
          kind="slider"
          min={0}
          max={90}
          step={5}
          unit="%"
          value={background.get('dim')}
          onchange={(v) => background.set('dim', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  {#if uploading}
    <p class="hint">正在上传…</p>
  {/if}
  {#if uploadError}
    <p class="hint err">{uploadError}</p>
  {/if}

  <!-- 隐藏的文件选择器，由上方按钮触发 -->
  <input
    class="file-input"
    type="file"
    accept="image/*"
    bind:this={imageInput}
    onchange={(e) => onPicked(e, 'image')}
  />
  <input
    class="file-input"
    type="file"
    accept="video/*"
    bind:this={videoInput}
    onchange={(e) => onPicked(e, 'video')}
  />

  <section class="note">
    <p>主题只改变配色变量，切换即时生效并自动记忆；背景图不再受主题颜色影响。</p>
    <p>自定义背景会上传到本机酒馆后端，本机仅保存文件名；加载失败时自动回落到角色头像。</p>
  </section>
</SubPage>

<style>
  .themes {
    display: flex;
    flex-direction: column;
  }
  .bg-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm);
  }
  .bg-actions .btn.on {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    color: var(--accent);
  }
  .bg-actions .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .file-input {
    display: none;
  }
  .hint {
    margin: 0;
    padding: 0 4px;
    font-size: 0.74rem;
    color: var(--text-muted);
  }
  .hint.err {
    color: var(--danger);
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
  .note p {
    margin: 0;
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.6;
  }
</style>
