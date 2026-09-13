<script lang="ts">
  /**
   * 世界书页（顶栏 tab 的独立页）。
   *
   * 职责：
   *   · 列表：一行一本，显示名称与条目数；点击 = 设为「当前激活」世界书
   *   · 管理：新建 / 编辑（含条目增删改）/ 删除 / 重命名
   *   · 表单：一律「标签在上、输入框在下」的垂直堆叠（窄屏友好）
   *
   * 与「设置 → 世界书」子页的分工：子页管**扫描/预算/匹配**等全局行为开关，
   * 本页管**书本身**的增删改查。二者共用 worldbook store，状态天然一致。
   *
   * 后端契约见 store 注释；降级后端（无 /api/worldinfo 写端点）下操作会返回
   * 可读错误并展示在页内，不抛异常、不白屏。
   */
  import { onMount } from 'svelte';
  import { worldbook } from '../stores/worldbook.svelte';
  import type { WorldInfoEntry } from '../lib/context/assembler';
  import { importWorldbook } from '../lib/backend';
  import { pushBack } from '../lib/back';
  import { logger } from '../lib/logger';

  // ── 导入世界书 ────────────────────────────────────────────────────────────
  // 契约：POST /api/worldinfo/import（multipart，文件字段 avatar，可选 name）→ { name }
  let importInput = $state<HTMLInputElement | null>(null);
  let importing = $state(false);
  let importHint = $state<{ ok: boolean; text: string } | null>(null);

  function openImport() {
    importHint = null;
    importInput?.click();
  }

  async function onPickImport(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 允许重复选同一文件
    if (!file) return;
    importing = true;
    importHint = null;
    const res = await importWorldbook(file);
    importing = false;
    if (!res.ok) {
      importHint = { ok: false, text: res.error ?? '导入失败' };
      return;
    }
    importHint = { ok: true, text: `已导入「${res.name}」` };
    logger.info('worldbook', '世界书导入成功', { name: res.name });
    await refresh();
  }

  /** 弹层里的条目草稿：origin 保留原始字段（keysecondary/order/position 等），
   *  仅覆盖被编辑的三个主字段，确保编辑社区世界书时不丢字段（round-trip）。 */
  interface DraftEntry {
    /** 稳定 key：条目增删时避免按 index 复用导致输入框状态错位 */
    id: number;
    origin: WorldInfoEntry | null;
    keywords: string;
    content: string;
    comment: string;
    constant: boolean;
    disable: boolean;
  }

  let draftSeq = 0;

  let loading = $state(false);
  /** 每本书的条目数（激活书取内存，其余即时拉取） */
  let counts = $state<Record<string, number>>({});

  // —— 新建弹层 ——
  let creating = $state(false);
  let newName = $state('');

  // —— 编辑弹层 ——
  let editingName = $state<string | null>(null); // 正在编辑的书名（原值）
  let editName = $state(''); // 可改名（保存时若变化则先重命名）
  let drafts = $state<DraftEntry[]>([]);

  // —— 删除确认 ——
  let confirmTarget = $state<string | null>(null);

  function toDrafts(entries: WorldInfoEntry[]): DraftEntry[] {
    return entries.map((e) => ({
      id: draftSeq++,
      origin: e,
      keywords: (e.key ?? []).join(', '),
      content: e.content ?? '',
      comment: e.comment ?? '',
      constant: e.constant === true,
      disable: e.disable === true,
    }));
  }

  function fromDrafts(list: DraftEntry[]): WorldInfoEntry[] {
    return list.map((d, i) => {
      const base: WorldInfoEntry = d.origin
        ? { ...d.origin }
        : { uid: i, key: [], content: '' };
      return {
        ...base,
        uid: i,
        // 中英文逗号都当分隔符，去掉空白项
        key: d.keywords
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        content: d.content,
        comment: d.comment.trim() ? d.comment.trim() : undefined,
        constant: d.constant ? true : undefined,
        disable: d.disable ? true : undefined,
      };
    });
  }

  async function loadCounts() {
    const names = worldbook.list.map((w) => w.name);
    const pairs = await Promise.all(
      names.map(async (n): Promise<[string, number]> => {
        if (n === worldbook.activeName) return [n, worldbook.entries.length];
        const entries = await worldbook.readEntries(n);
        return [n, entries.length];
      }),
    );
    counts = Object.fromEntries(pairs);
  }

  async function refresh() {
    loading = true;
    await worldbook.load(true);
    await loadCounts();
    loading = false;
  }

  async function pick(name: string) {
    await worldbook.select(name);
    counts = { ...counts, [name]: worldbook.entries.length };
  }

  function openCreate() {
    newName = '';
    creating = true;
  }

  async function submitCreate() {
    const ok = await worldbook.create(newName);
    if (ok) {
      creating = false;
      await pick(newName.trim());
      await loadCounts();
    }
  }

  async function openEdit(name: string) {
    editingName = name;
    editName = name;
    drafts = [];
    logger.debug('worldbook', '打开编辑', { name });
    const entries =
      name === worldbook.activeName
        ? [...worldbook.entries]
        : await worldbook.readEntries(name);
    drafts = toDrafts(entries);
  }

  function addDraft() {
    drafts = [
      ...drafts,
      { id: draftSeq++, origin: null, keywords: '', content: '', comment: '', constant: false, disable: false },
    ];
  }

  function removeDraft(id: number) {
    drafts = drafts.filter((d) => d.id !== id);
  }

  async function submitEdit() {
    if (!editingName) return;
    const targetName = editName.trim();
    if (!targetName) {
      worldbook.lastWriteError = '世界书名字不能为空';
      return;
    }
    const entries = fromDrafts(drafts);
    const originalName = editingName;

    // 改名在前：后端 rename 需连同 data 提交，随后再用编辑后的条目覆盖写入
    if (targetName !== originalName) {
      const renamed = await worldbook.renameWorld(originalName, targetName);
      if (!renamed) return;
      const saved = await worldbook.saveEntries(targetName, entries);
      if (!saved) return;
    } else {
      const saved = await worldbook.saveEntries(originalName, entries);
      if (!saved) return;
    }

    editingName = null;
    await loadCounts();
  }

  async function confirmDelete() {
    if (!confirmTarget) return;
    const ok = await worldbook.remove(confirmTarget);
    if (ok) {
      confirmTarget = null;
      await loadCounts();
    }
  }

  onMount(() => {
    if (!worldbook.loaded) {
      loading = true;
      worldbook.load().finally(() => {
        loading = false;
        loadCounts();
      });
    } else {
      loadCounts();
    }
    logger.debug('worldbook', '进入世界书页');
  });

  // 弹层打开时拦截返回键（关闭弹层而非退出页面）
  $effect(() => {
    if (!creating && !editingName && !confirmTarget) return;
    const off = pushBack(() => {
      if (confirmTarget) {
        confirmTarget = null;
        return true;
      }
      if (creating) {
        creating = false;
        return true;
      }
      if (editingName) {
        editingName = null;
        return true;
      }
      return false;
    }, 60);
    return off;
  });
</script>

<div class="wb-page">
  <header class="page-bar">
    <h1>世界书</h1>
    <div class="bar-actions">
      <button class="btn btn-sm" onclick={openImport} disabled={importing}>
        {importing ? '导入中…' : '导入'}
      </button>
      <button class="add" onclick={refresh} aria-label="刷新世界书列表" title="刷新">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 10-2.3 5.7M20 4v6h-6" />
        </svg>
      </button>
      <button class="add" onclick={openCreate} aria-label="新建世界书" title="新建">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
    <!-- 隐藏的文件选择器，由「导入」触发 -->
    <input
      class="file-input"
      type="file"
      accept=".json"
      bind:this={importInput}
      onchange={onPickImport}
    />
  </header>

  {#if worldbook.lastWriteError}
    <div class="banner error" role="alert">{worldbook.lastWriteError}</div>
  {/if}
  {#if importHint}
    <div class="banner" class:ok={importHint.ok} class:error={!importHint.ok} role="status">
      {importHint.text}
    </div>
  {/if}

  {#if loading && worldbook.list.length === 0}
    <div class="state">
      <div class="spinner" aria-label="加载中"></div>
      <p>正在加载世界书…</p>
    </div>
  {:else if worldbook.list.length === 0}
    <div class="state">
      <div class="mark">·</div>
      <p>还没有世界书</p>
      <p class="hint">世界书用于按关键词注入设定。点右上角「+」新建一本。</p>
      <div class="state-actions">
        <button class="btn btn-accent" onclick={openCreate}>新建世界书</button>
        <button class="btn" onclick={refresh}>重新加载</button>
      </div>
    </div>
  {:else}
    <ul class="list">
      {#each worldbook.list as w (w.fileId)}
        {@const active = worldbook.activeName === w.name}
        <li>
          <div class="item glass" class:selected={active}>
            <button class="pick" onclick={() => pick(w.name)} aria-pressed={active}>
              <span class="text">
                <span class="name">{w.name}</span>
                <span class="desc">
                  {counts[w.name] ?? 0} 条{active ? ' · 当前激活' : ''}
                </span>
              </span>
              {#if active}
                <span class="check" aria-hidden="true">✓</span>
              {/if}
            </button>
            <div class="row-actions">
              <button class="mini" onclick={() => openEdit(w.name)} aria-label="编辑">编辑</button>
              <button
                class="mini danger"
                onclick={() => (confirmTarget = w.name)}
                aria-label="删除"
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

<!-- ========== 新建弹层 ========== -->
{#if creating}
  <div class="overlay" role="presentation">
    <div class="modal glass" role="dialog" aria-modal="true" aria-label="新建世界书">
      <header class="modal-bar">
        <h2>新建世界书</h2>
        <button class="close" onclick={() => (creating = false)} aria-label="关闭">✕</button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">名称</span>
          <input
            class="input"
            type="text"
            placeholder="例如：世界观设定"
            value={newName}
            oninput={(e) => (newName = e.currentTarget.value)}
          />
        </label>
        {#if worldbook.lastWriteError}
          <p class="err">{worldbook.lastWriteError}</p>
        {/if}
      </div>
      <footer class="modal-foot">
        <button class="btn" onclick={() => (creating = false)}>取消</button>
        <button
          class="btn btn-accent"
          onclick={submitCreate}
          disabled={worldbook.writing}
        >
          {worldbook.writing ? '创建中…' : '创建'}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- ========== 编辑弹层（名称 + 条目增删改） ========== -->
{#if editingName}
  <div class="overlay" role="presentation">
    <div class="modal glass tall" role="dialog" aria-modal="true" aria-label="编辑世界书">
      <header class="modal-bar">
        <h2>编辑世界书</h2>
        <button class="close" onclick={() => (editingName = null)} aria-label="关闭">✕</button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">名称</span>
          <input
            class="input"
            type="text"
            value={editName}
            oninput={(e) => (editName = e.currentTarget.value)}
          />
        </label>

        <div class="entries-head">
          <span class="field-label">条目（{drafts.length}）</span>
          <button class="mini" onclick={addDraft}>+ 添加条目</button>
        </div>

        {#if drafts.length === 0}
          <p class="hint">暂无条目，点「+ 添加条目」新增。</p>
        {/if}

        {#each drafts as d, i (d.id)}
          <div class="entry">
            <div class="entry-head">
              <span class="entry-no">#{i + 1}</span>
              <div class="entry-flags">
                <label class="flag">
                  <input
                    type="checkbox"
                    checked={d.constant}
                    onchange={(e) => (d.constant = e.currentTarget.checked)}
                  />
                  <span>常驻</span>
                </label>
                <label class="flag">
                  <input
                    type="checkbox"
                    checked={d.disable}
                    onchange={(e) => (d.disable = e.currentTarget.checked)}
                  />
                  <span>禁用</span>
                </label>
                <button class="mini danger" onclick={() => removeDraft(i)}>删除</button>
              </div>
            </div>

            <label class="field">
              <span class="field-label">触发关键词（逗号分隔）</span>
              <input
                class="input"
                type="text"
                placeholder="例如：魔法, 学院"
                value={d.keywords}
                oninput={(e) => (d.keywords = e.currentTarget.value)}
              />
            </label>

            <label class="field">
              <span class="field-label">内容</span>
              <textarea
                class="textarea"
                rows="4"
                placeholder="命中关键词时注入的设定文本"
                value={d.content}
                oninput={(e) => (d.content = e.currentTarget.value)}
              ></textarea>
            </label>

            <label class="field">
              <span class="field-label">备注</span>
              <input
                class="input"
                type="text"
                placeholder="仅自己可见的说明（可选）"
                value={d.comment}
                oninput={(e) => (d.comment = e.currentTarget.value)}
              />
            </label>
          </div>
        {/each}

        {#if worldbook.lastWriteError}
          <p class="err">{worldbook.lastWriteError}</p>
        {/if}
      </div>
      <footer class="modal-foot">
        <button class="btn" onclick={() => (editingName = null)}>取消</button>
        <button
          class="btn btn-accent"
          onclick={submitEdit}
          disabled={worldbook.writing}
        >
          {worldbook.writing ? '保存中…' : '保存'}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- ========== 删除确认 ========== -->
{#if confirmTarget}
  <div class="overlay" role="presentation">
    <div class="modal glass" role="dialog" aria-modal="true" aria-label="删除确认">
      <header class="modal-bar">
        <h2>删除世界书</h2>
      </header>
      <div class="modal-body">
        <p class="confirm-text">确定删除「{confirmTarget}」吗？此操作不可撤销。</p>
        {#if worldbook.lastWriteError}
          <p class="err">{worldbook.lastWriteError}</p>
        {/if}
      </div>
      <footer class="modal-foot">
        <button class="btn" onclick={() => (confirmTarget = null)}>取消</button>
        <button class="btn danger-btn" onclick={confirmDelete} disabled={worldbook.writing}>
          {worldbook.writing ? '删除中…' : '删除'}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .wb-page {
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
  .bar-actions {
    display: flex;
    gap: var(--gap-sm);
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
  .banner.ok {
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    color: var(--accent);
    font-size: 0.8rem;
  }
  .btn-sm {
    padding: 7px 12px;
    font-size: 0.76rem;
  }
  .file-input {
    display: none;
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

  /* ---- 三态（空/载/错） ---- */
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
  .modal.tall {
    max-height: calc(var(--app-height) - var(--gap-xl));
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

  .entries-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: var(--gap-sm);
  }

  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    padding: var(--gap-md);
    border-radius: var(--radius-lg);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
  }
  .entry-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-sm);
  }
  .entry-no {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
  }
  .entry-flags {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
  }
  .flag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
  }
  .flag input {
    accent-color: var(--accent);
  }

  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .err {
    margin: 0;
    font-size: 0.78rem;
    color: var(--danger);
  }
  .confirm-text {
    margin: 0;
    font-size: 0.86rem;
    color: var(--text);
    line-height: 1.6;
  }
  .danger-btn {
    background: rgba(192, 57, 43, 0.12);
    border-color: rgba(192, 57, 43, 0.35);
    color: var(--danger);
  }
</style>
