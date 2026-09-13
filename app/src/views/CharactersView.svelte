<script lang="ts">
  /**
   * 角色页（对齐 Tavo 的信息架构）。
   *
   * 职责：
   *   · 列表：一行一个角色（名字 + 描述 + 选中态），点击 = 选择并回聊天页
   *   · 管理：新建 / 编辑 / 删除（后端契约为 SillyBunny 的 /api/characters/*）
   *   · 表单：一律「标签在上、输入框在下」的垂直堆叠（窄屏友好，硬性要求）
   *
   * 后端契约见 backend.ts；降级后端（无写端点）下操作会返回可读错误并展示在
   * 页内，不抛异常、不白屏。
   */
  import { onMount } from 'svelte';
  import Avatar from '../lib/Avatar.svelte';
  import { characters } from '../stores/characters.svelte';
  import type { CharacterCard, CharacterInput, CharacterPreserve } from '../lib/backend';
  import { characterAvatarUrl } from '../lib/backend';
  import { pushBack } from '../lib/back';
  import { logger } from '../lib/logger';

  interface Props {
    /** 选择角色后跳到聊天 */
    onOpenChat: () => void;
  }
  let { onOpenChat }: Props = $props();

  let loading = $state(false);

  /** 表单草稿：tags 用逗号分隔字符串输入，提交时切分成数组。 */
  interface Draft {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    firstMes: string;
    mesExample: string;
    creatorNotes: string;
    tagsText: string;
  }

  function emptyDraft(): Draft {
    return {
      name: '',
      description: '',
      personality: '',
      scenario: '',
      firstMes: '',
      mesExample: '',
      creatorNotes: '',
      tagsText: '',
    };
  }

  let formOpen = $state(false);
  /** null = 新建；否则为被编辑角色的原名 */
  let editingName = $state<string | null>(null);
  let draft = $state<Draft>(emptyDraft());
  let saving = $state(false);
  /**
   * 被编辑角色卡的「非表单字段」（`/get` 的 json_data / talkativeness / fav / create_date / chat）。
   *
   * 保存时必须回传：后端会用请求体的值无条件覆盖这些字段，缺省即重置 ——
   * 丢了它，`world` 绑定、`character_book`、`system_prompt`、收藏标记会被静默清空（无报错）。
   * 拉取失败时为 null —— 此时**不阻断编辑**，只放弃这些字段（降级后端无 /get）。
   */
  let editingPreserve = $state<CharacterPreserve | null>(null);

  async function refresh() {
    loading = true;
    await characters.load(true);
    loading = false;
  }

  function pick(name: string) {
    const c = characters.list.find((x) => x.name === name) ?? null;
    characters.select(c);
    onOpenChat();
  }

  function openCreate() {
    characters.lastError = null;
    editingName = null;
    editingPreserve = null;
    draft = emptyDraft();
    formOpen = true;
  }

  async function openEdit(c: CharacterCard) {
    characters.lastError = null;
    editingName = c.name;
    editingPreserve = null;
    // 先用列表可见字段预填，避免等待；随后用完整字段覆盖
    draft = {
      ...emptyDraft(),
      name: c.name,
      description: c.description ?? '',
      tagsText: (c.tags ?? []).join(', '),
    };
    formOpen = true;

    if (!c.avatar) return;
    const want = c.name;
    const detail = await characters.detail(c.avatar);
    // 竞态防护：请求期间用户可能已关闭表单或切换编辑对象
    if (!formOpen || editingName !== want || !detail) return;
    editingPreserve = detail.preserve;
    draft = {
      name: detail.name || want,
      description: detail.description ?? '',
      personality: detail.personality ?? '',
      scenario: detail.scenario ?? '',
      firstMes: detail.firstMes ?? '',
      mesExample: detail.mesExample ?? '',
      creatorNotes: detail.creatorNotes ?? '',
      tagsText: (detail.tags ?? []).join(', '),
    };
  }

  function closeForm() {
    formOpen = false;
    saving = false;
  }

  async function submitForm() {
    const input: CharacterInput = {
      name: draft.name.trim(),
      description: draft.description,
      personality: draft.personality,
      scenario: draft.scenario,
      firstMes: draft.firstMes,
      mesExample: draft.mesExample,
      creatorNotes: draft.creatorNotes,
      tags: draft.tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
    if (!input.name) {
      characters.lastError = '角色名不能为空';
      return;
    }
    saving = true;
    const ok = editingName
      ? await characters.update(editingName, input, editingPreserve ?? undefined)
      : await characters.create(input);
    saving = false;
    if (ok) formOpen = false;
  }

  async function removeOne(name: string) {
    if (!confirm(`删除角色「${name}」？此操作不可撤销。`)) return;
    await characters.remove(name);
  }

  onMount(() => {
    if (!characters.loaded) {
      loading = true;
      characters.load().finally(() => (loading = false));
    }
    logger.debug('characters', '进入角色页');
  });

  // 表单打开时拦截返回键（关闭表单而非退出页面）
  $effect(() => {
    if (!formOpen) return;
    const off = pushBack(() => {
      formOpen = false;
      return true;
    }, 60);
    return off;
  });
</script>

<div class="chars-page">
  <header class="page-bar">
    <h1>角色</h1>
    <button class="add" onclick={openCreate} aria-label="新建角色" title="新建角色">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
  </header>

  {#if characters.lastError}
    <div class="banner error" role="alert">{characters.lastError}</div>
  {/if}

  {#if loading && characters.list.length === 0}
    <div class="state">
      <div class="spinner" aria-label="加载中"></div>
      <p>正在加载角色…</p>
    </div>
  {:else if characters.list.length === 0}
    <div class="state">
      <div class="mark">·</div>
      <p>还没有角色</p>
      <p class="hint">点右上角「+」新建一个角色卡，开始对话。</p>
      <div class="state-actions">
        <button class="btn btn-accent" onclick={openCreate}>新建角色</button>
        <button class="btn" onclick={refresh}>重新加载</button>
      </div>
    </div>
  {:else}
    <ul class="list">
      {#each characters.list as c (c.name)}
        <li>
          <div class="item glass" class:selected={characters.active?.name === c.name}>
            <button
              class="pick"
              onclick={() => pick(c.name)}
              aria-pressed={characters.active?.name === c.name}
            >
              <Avatar src={characterAvatarUrl(c.avatar)} name={c.name} size={42} />
              <span class="text">
                <span class="name">{c.name}</span>
                <span class="desc">{c.description || '暂无描述'}</span>
              </span>
              {#if characters.active?.name === c.name}
                <span class="check" aria-hidden="true">✓</span>
              {/if}
            </button>
            <div class="row-actions">
              <button class="mini" onclick={() => openEdit(c)} aria-label="编辑角色">编辑</button>
              <button
                class="mini danger"
                onclick={() => removeOne(c.name)}
                aria-label="删除角色"
              >
                删除
              </button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<!-- ========== 新建 / 编辑 弹层 ========== -->
{#if formOpen}
  <div class="overlay" role="presentation">
    <div
      class="modal glass"
      role="dialog"
      aria-modal="true"
      aria-label={editingName ? '编辑角色' : '新建角色'}
    >
      <header class="modal-bar">
        <h2>{editingName ? '编辑角色' : '新建角色'}</h2>
        <button class="close" onclick={closeForm} aria-label="关闭">✕</button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">角色名 *</span>
          <input
            class="input"
            type="text"
            placeholder="例如：艾莉丝"
            value={draft.name}
            oninput={(e) => (draft.name = e.currentTarget.value)}
          />
        </label>

        <label class="field">
          <span class="field-label">描述</span>
          <textarea
            class="textarea"
            rows={3}
            placeholder="角色的外貌、身份、背景等"
            value={draft.description}
            oninput={(e) => (draft.description = e.currentTarget.value)}
          ></textarea>
        </label>

        <label class="field">
          <span class="field-label">性格</span>
          <textarea
            class="textarea"
            rows={2}
            placeholder="角色的性格特征"
            value={draft.personality}
            oninput={(e) => (draft.personality = e.currentTarget.value)}
          ></textarea>
        </label>

        <label class="field">
          <span class="field-label">场景</span>
          <textarea
            class="textarea"
            rows={2}
            placeholder="对话发生的场景设定"
            value={draft.scenario}
            oninput={(e) => (draft.scenario = e.currentTarget.value)}
          ></textarea>
        </label>

        <label class="field">
          <span class="field-label">开场白</span>
          <textarea
            class="textarea"
            rows={4}
            placeholder="角色在对话开始时说的话"
            value={draft.firstMes}
            oninput={(e) => (draft.firstMes = e.currentTarget.value)}
          ></textarea>
        </label>

        <label class="field">
          <span class="field-label">示例对话</span>
          <textarea
            class="textarea"
            rows={4}
            placeholder="示范对话格式，帮助模型学习角色语气"
            value={draft.mesExample}
            oninput={(e) => (draft.mesExample = e.currentTarget.value)}
          ></textarea>
        </label>

        <label class="field">
          <span class="field-label">创作者备注</span>
          <textarea
            class="textarea"
            rows={2}
            placeholder="仅自己可见的说明（可选）"
            value={draft.creatorNotes}
            oninput={(e) => (draft.creatorNotes = e.currentTarget.value)}
          ></textarea>
        </label>

        <label class="field">
          <span class="field-label">标签（用逗号分隔）</span>
          <input
            class="input"
            type="text"
            placeholder="例如：奇幻, 冒险, 治愈"
            value={draft.tagsText}
            oninput={(e) => (draft.tagsText = e.currentTarget.value)}
          />
        </label>

        {#if characters.lastError}
          <p class="err">{characters.lastError}</p>
        {/if}
      </div>
      <footer class="modal-foot">
        <button class="btn" onclick={closeForm}>取消</button>
        <button class="btn btn-accent" onclick={submitForm} disabled={saving}>
          {saving ? '保存中…' : editingName ? '保存' : '创建'}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .chars-page {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    min-height: 0;
  }

  .page-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
    flex-shrink: 0;
  }
  .page-bar h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
  }
  .add {
    width: 36px;
    height: 36px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
    color: var(--accent);
    display: grid;
    place-items: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .add svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .add:active {
    transform: scale(0.94);
  }

  .banner.error {
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    background: rgba(192, 57, 43, 0.1);
    border: 1px solid rgba(192, 57, 43, 0.3);
    color: var(--danger);
    font-size: 0.8rem;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    min-height: 0;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: 12px var(--gap-md) 12px var(--gap-lg);
    border-radius: var(--radius-xl);
    transition: all var(--dur-fast) var(--ease-standard);
    box-sizing: border-box;
  }
  .item.selected {
    border-color: var(--accent-border);
    box-shadow: 0 0 0 1px var(--accent-border), var(--glass-shadow);
  }
  .pick {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .desc {
    font-size: 0.74rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .check {
    color: var(--accent);
    font-weight: 800;
    flex-shrink: 0;
  }
  .row-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .mini {
    padding: 5px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease-standard);
    -webkit-tap-highlight-color: transparent;
    white-space: nowrap;
  }
  .mini:hover {
    background: var(--neutral-2);
    color: var(--text);
  }
  .mini:active {
    transform: scale(0.94);
  }
  .mini.danger {
    color: var(--danger);
  }

  .state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--gap-sm);
    text-align: center;
    padding: var(--gap-2xl) var(--gap-lg);
  }
  .state p {
    margin: 0;
    font-size: 0.84rem;
    color: var(--text-muted);
  }
  .state .hint {
    font-size: 0.74rem;
    color: var(--text-dim);
    max-width: 320px;
  }
  .state-actions {
    display: flex;
    gap: var(--gap-sm);
    margin-top: var(--gap-sm);
  }
  .mark {
    width: 52px;
    height: 52px;
    border-radius: var(--radius-2xl);
    display: grid;
    place-items: center;
    background: var(--neutral-1);
    border: 1px solid var(--glass-border);
    color: var(--text-faint);
    font-size: 1.6rem;
    margin-bottom: var(--gap-sm);
  }
  .spinner {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid var(--neutral-3);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ---- 弹层 ---- */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--gap-lg);
    background: rgba(20, 26, 36, 0.4);
  }
  .modal {
    width: 100%;
    max-width: 460px;
    max-height: calc(var(--app-height) - 2 * var(--gap-xl));
    border-radius: var(--radius-2xl);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: slideUp var(--dur-base) var(--ease-standard);
  }
  .modal-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--gap-md) var(--gap-lg);
    border-bottom: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .modal-bar h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  .close {
    width: 30px;
    height: 30px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.9rem;
    cursor: pointer;
  }
  .close:active {
    transform: scale(0.9);
  }
  .modal-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    padding: var(--gap-lg);
  }
  .modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-sm);
    padding: var(--gap-md) var(--gap-lg);
    border-top: 1px solid var(--glass-border);
    flex-shrink: 0;
  }

  /* 表单字段：标签在上、输入框在下（垂直堆叠，硬性要求） */
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-dim);
  }
  .err {
    margin: 0;
    font-size: 0.76rem;
    color: var(--danger);
  }
</style>
