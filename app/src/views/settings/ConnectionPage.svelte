<script lang="ts">
  /**
   * 连接设置页。
   *
   * 产品原则：默认情形用户什么都不用填 —— App 自带后端，开箱即用。
   * 「高级」折叠里才出现自定义地址，供桌面端接局域网后端。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import { getBaseUrl, setBaseUrl } from '../../lib/backend';
  import { modelConfig } from '../../stores/model.svelte';
  import { apiProfiles } from '../../stores/api-profiles.svelte';
  import { normalizeApiUrl } from '../../lib/api-url';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  let showAdvanced = $state(false);
  let draftUrl = $state(getBaseUrl());

  // 列表 / 编辑两级视图：编辑态用本地草稿驱动输入框，并即时写入 profiles store。
  // 草稿作为输入框的唯一数据源，避免 value 属性回写把正在输入的文本冲掉。
  let editId = $state<string | null>(null);
  let draftName = $state('');
  let draftApiUrl = $state('');
  let draftApiKey = $state('');
  let draftModel = $state('');

  /** 进入编辑态：把该配置现值灌入草稿。 */
  function startEdit(id: string) {
    const p = apiProfiles.list.find((x) => x.id === id);
    if (!p) return;
    editId = id;
    draftName = p.name;
    draftApiUrl = p.apiUrl;
    draftApiKey = p.apiKey;
    draftModel = p.model;
  }

  /** 编辑并即时落盘（不经本地缓存，避免返回时丢失）。 */
  function editPatch(patch: Partial<{ name: string; apiUrl: string; apiKey: string; model: string }>) {
    if (editId) apiProfiles.update(editId, patch);
  }

  // 补全预览：输入还不是最终形态时，提示实际会保存成什么
  const urlPreview = $derived(
    draftApiUrl.trim() && normalizeApiUrl(draftApiUrl) !== draftApiUrl
      ? normalizeApiUrl(draftApiUrl)
      : '',
  );

  function saveUrl() {
    const url = draftUrl.trim().replace(/\/+$/, '');
    if (url) setBaseUrl(url);
    showAdvanced = false;
  }
</script>

<SubPage title="连接" {onBack}>
  <SettingGroup>
    <SettingRow label="服务状态" value="已内置，自动连接" />
    <SettingRow label="模式" value="随应用启动" />
  </SettingGroup>

  <section class="note">
    <p>
      本应用自带后端服务，无需配置即可对话。下面的选项仅用于把桌面版指向
      局域网内的另一台设备。
    </p>
  </section>

  <SettingGroup>
    <SettingRow
      label="自定义服务地址"
      desc={showAdvanced ? undefined : '一般无需修改'}
      kind="toggle"
      checked={showAdvanced}
      onchange={(v) => (showAdvanced = v)}
    />
  </SettingGroup>

  {#if showAdvanced}
    <SettingGroup title="服务地址">
      <div class="url-block">
        <input
          class="url"
          type="text"
          bind:value={draftUrl}
          placeholder="http://192.168.1.10:8000"
          spellcheck="false"
        />
        <button class="save" onclick={saveUrl}>保存</button>
      </div>
      <SettingRow label="当前生效" value={getBaseUrl()} />
    </SettingGroup>
  {/if}

  {#if editId === null}
    <!-- 列表视图：多套配置导航，点进编辑，随时切换 -->
    <SettingGroup title="模型 API">
      {#if apiProfiles.list.length === 0}
        <SettingRow label="还没有配置" desc="点下方新增一条，填入端点与密钥" />
      {:else}
        {#each apiProfiles.list as p (p.id)}
          <SettingRow
            label={p.name}
            desc={p.apiUrl}
            value={p.id === apiProfiles.activeId ? '使用中' : undefined}
            kind="link"
            onclick={() => startEdit(p.id)}
          />
        {/each}
      {/if}
      <SettingRow
        label="＋ 新增配置"
        desc="保存多套 API 端点，随时切换"
        kind="link"
        onclick={() => {
          const p = apiProfiles.add();
          startEdit(p.id);
        }}
      />
    </SettingGroup>
  {:else}
    <!-- 编辑视图：上下布局，窄屏不再左右挤压；改动即时落盘 -->
    <SettingGroup>
      <SettingRow label="← 返回配置列表" kind="link" onclick={() => (editId = null)} />
    </SettingGroup>

    <SettingGroup title="编辑配置">
      <SettingRow label="配置名称" stacked>
        {#snippet trailing()}
          <Field
            kind="text"
            block
            placeholder="如 百炼 / Token Plan"
            value={draftName}
            onchange={(v) => {
              draftName = String(v);
              editPatch({ name: draftName });
            }}
          />
        {/snippet}
      </SettingRow>

      <SettingRow
        label="API 地址"
        desc={urlPreview ? `将保存为：${urlPreview}` : '只需填到 /v1 即可，会自动补全 /chat/completions'}
        stacked
      >
        {#snippet trailing()}
          <input
            class="url wide"
            type="text"
            spellcheck="false"
            placeholder="https://…/v1"
            value={draftApiUrl}
            oninput={(e) => (draftApiUrl = e.currentTarget.value)}
            onchange={() => {
              draftApiUrl = normalizeApiUrl(draftApiUrl);
              editPatch({ apiUrl: draftApiUrl });
            }}
          />
        {/snippet}
      </SettingRow>

      <SettingRow label="API 密钥" desc="仅保存在本机，用于 Authorization 头" stacked>
        {#snippet trailing()}
          <input
            class="url wide"
            type="password"
            spellcheck="false"
            placeholder="sk-…"
            autocomplete="off"
            value={draftApiKey}
            oninput={(e) => (draftApiKey = e.currentTarget.value)}
            onchange={() => editPatch({ apiKey: draftApiKey })}
          />
        {/snippet}
      </SettingRow>

      <SettingRow label="模型名称" desc="留空则由端点决定" stacked>
        {#snippet trailing()}
          <Field
            kind="text"
            block
            placeholder="如 deepseek-v4-flash-0731"
            value={draftModel}
            onchange={(v) => {
              draftModel = String(v);
              editPatch({ model: draftModel });
            }}
          />
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <div class="actions">
      {#if editId !== apiProfiles.activeId}
        <button class="btn" onclick={() => editId && apiProfiles.activate(editId)}>设为当前使用中</button>
      {/if}
      <button
        class="btn danger"
        onclick={() => {
          if (!editId) return;
          apiProfiles.remove(editId);
          editId = null;
        }}
      >
        删除此配置
      </button>
    </div>
  {/if}

  <!-- 地址已有默认值，真正的缺口是密钥；两个都缺才最该提示 -->
  {#if !apiProfiles.active?.apiKey}
    <section class="note warn">
      <p>还没有填写 API 密钥，暂时无法对话。在「模型 API」里选一套配置并填入密钥后即可开始。</p>
    </section>
  {/if}

  <SettingGroup title="请求">
    <SettingRow
      label="流式输出"
      desc="逐字显示回复"
      kind="toggle"
      checked={modelConfig.stream}
      onchange={(v) => modelConfig.set('stream', v)}
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
  .note.warn {
    border-color: color-mix(in srgb, var(--accent) 26%, transparent);
    background: var(--accent-soft);
  }
  .note.warn p {
    color: var(--accent);
  }

  .url-block {
    display: flex;
    gap: var(--gap-sm);
    padding: 14px var(--gap-lg);
  }
  /* 服务地址整行输入：不限宽，占满可用空间 */
  .url-block .url {
    max-width: none;
    padding: 9px 12px;
    font-size: 0.78rem;
  }
  .url {
    flex: 1;
    min-width: 0;
    width: 100%;
    max-width: 190px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.74rem;
    outline: none;
    box-sizing: border-box;
  }
  .url:focus {
    border-color: var(--accent-border);
  }
  /* 上下布局里的整行输入：去掉行内宽度上限 */
  .url.wide {
    max-width: none;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
  }
  .btn {
    width: 100%;
    padding: 11px 16px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:active {
    transform: scale(0.99);
  }
  .btn.danger {
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .save {
    padding: 9px 18px;
    border-radius: var(--radius-md);
    border: 1px solid var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: inherit;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
</style>
