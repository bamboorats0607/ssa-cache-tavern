<script lang="ts">
  /**
   * 学习建议页（B' 面板 + Phase 4 落盘，spec T3.2 / T4.1）。// [SSA-LEARN]
   *
   * ── 形态纪律 ──────────────────────────────────────────────────────────────
   * · **列表 + 应用/拒绝/编辑**，不是数值面板（R-08）：θ / minFreq / window /
   *   置信度数字一律不显示；每条只给「哪一类 / 来自哪条通道 / 正文」。
   * · 零建议空态、后端/存储降级态、运行中态**都内联渲染**，不用弹窗（R-11）。
   * · 「采纳」= **真的写进你选定的世界书**（Phase 4 / C-07：只走 saveEntries）；
   *   写入失败会当场说明且不改本机记录（R8）；已写入的条目在本页可**显式撤销**。
   * · 观测性产物（场景触发 / 词对耦合 / 名称归并）没有可注入正文 → 不给「采纳」按钮，
   *   只显示为参考（避免「采纳了却什么都没发生」）。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import { onMount } from 'svelte';
  import { learningGate } from '../../lib/learning/suggest-gate.svelte';
  import { isAppliable } from '../../lib/learning/apply-core';
  import { KIND_LABEL, type SuggestionItem } from '../../lib/learning/gate-core';
  import { worldbook } from '../../stores/worldbook.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  /** 编辑中的条目 uid（null = 无） */
  let editingUid = $state<string | null>(null);
  let draft = $state('');

  const view = $derived(learningGate.view);

  // 拉一次世界书列表（目标书下拉的数据源）；失败不阻塞本页（降级后端没有该接口）
  onMount(() => {
    if (!worldbook.loaded) void worldbook.load();
  });

  function onPickBook(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    learningGate.setTargetBook(v || null);
  }

  function startEdit(it: SuggestionItem) {
    editingUid = it.uid;
    draft = it.detail;
  }

  function saveEdit(it: SuggestionItem) {
    const text = draft.trim();
    if (!text) return;
    void learningGate.edit(it.uid, text);
    editingUid = null;
  }
</script>

<SubPage title="学习建议" {onBack}>
  <div class="stack">
    <!-- 边界声明：产物不会自动生效，写入必须逐条确认（C-06 / C-07 / R-02） -->
    <p class="boundary">
      学习产物<strong>不会</strong>自动生效，也不会自动写进世界书：这里逐条确认，
      只有你点「采纳」的那几条会被写入下面选定的世界书，且随时可以撤销。
      关掉学习开关<strong>不会</strong>删除已写入的条目。
    </p>

    <SettingGroup title="写入目标">
      <SettingRow
        label="世界书"
        desc="采纳的建议写进这本书；建议用一本专用书，避免与你自己写的条目混在一起"
        stacked
      >
        {#snippet trailing()}
          <div class="actions">
            <select
              class="pick"
              aria-label="选择目标世界书"
              value={learningGate.targetBook ?? ''}
              onchange={onPickBook}
            >
              <option value="">（未选择）</option>
              {#each worldbook.list as w (w.fileId)}
                <option value={w.name}>{w.name}</option>
              {/each}
              {#if learningGate.targetBook && !worldbook.list.some((w) => w.name === learningGate.targetBook)}
                <option value={learningGate.targetBook}>{learningGate.targetBook}</option>
              {/if}
            </select>
            <button
              class="btn"
              disabled={learningGate.writing}
              onclick={() => learningGate.createTargetBook()}
            >
              新建专用世界书
            </button>
          </div>
        {/snippet}
      </SettingRow>
    </SettingGroup>

    <SettingGroup title="语料">
      <SettingRow
        label="从本机对话学习"
        desc="只读本机的单角色对话记录（不含群聊），在本机计算"
        stacked
      >
        {#snippet trailing()}
          <div class="actions">
            <button
              class="btn btn-accent"
              disabled={view.kind === 'running'}
              onclick={() => learningGate.start()}
            >
              {view.kind === 'running' ? '学习中…' : learningGate.items.length ? '重新学习' : '开始学习'}
            </button>
            {#if learningGate.ledger.decisions.length > 0}
              <button class="btn" onclick={() => learningGate.clearLedger()}>清空采纳记录</button>
            {/if}
          </div>
        {/snippet}
      </SettingRow>
      {#if learningGate.lastRunInfo}
        <SettingRow
          label="上次学习来源"
          value={`${learningGate.lastRunInfo.sessions} 个对话 · ${learningGate.lastRunInfo.turns} 轮 · ${learningGate.lastRunInfo.messages} 条语料`}
          stacked
        />
      {/if}
    </SettingGroup>

    <!-- 结果区：五态各自内联，互不混淆（R-11） -->
    {#if view.kind === 'idle'}
      <p class="hint">
        点「开始学习」，从本机对话里找出反复出现的场景词、句式模板与人名写法，供你逐条确认。
      </p>
    {:else if view.kind === 'running'}
      <p class="hint">正在本机计算…（语料多时需要一两秒，期间界面会短暂停顿）</p>
    {:else if view.kind === 'error'}
      <!-- 失败态：明确说「失败」，绝不退化成「没有建议」 -->
      <p class="hint err">学习失败：{view.message}</p>
    {:else if view.kind === 'empty'}
      <p class="hint">{view.message}</p>
    {:else}
      {#if view.warnMassAccept}
        <p class="hint err">
          采纳比例偏高（超过三成是「未修改直接采纳」）。建议逐条看一眼正文再采纳——
          学习产物只是线索，未必都符合你的设定。
        </p>
      {/if}

      <SettingGroup
        title={`待确认 · ${view.pending} 条${
          learningGate.tally.applied + learningGate.tally.edited + learningGate.tally.rejected > 0
            ? `（已处理 采纳 ${learningGate.tally.applied} · 编辑 ${learningGate.tally.edited} · 拒绝 ${learningGate.tally.rejected}）`
            : ''
        }`}
      >
        {#each learningGate.pendingItems as it (it.uid)}
          <SettingRow label={it.title} desc={`${KIND_LABEL[it.kind]} · 来自${
            it.source === 'ngram' ? '词频统计' :
            it.source === 'cooccurrence' ? '共现统计' :
            it.source === 'regex-slot' ? '句式槽位' : '名称归并'
          }`} stacked>
            {#snippet trailing()}
              {#if editingUid === it.uid}
                <input
                  class="edit"
                  type="text"
                  bind:value={draft}
                  aria-label={`编辑 ${it.title}`}
                />
                <button class="btn btn-accent" onclick={() => saveEdit(it)}>保存并采纳</button>
                <button class="btn" onclick={() => (editingUid = null)}>取消</button>
              {:else if isAppliable(it.kind)}
                <button
                  class="btn btn-accent"
                  disabled={learningGate.writing}
                  onclick={() => learningGate.apply(it.uid, it.detail)}
                >
                  采纳
                </button>
                <button class="btn" onclick={() => startEdit(it)}>编辑</button>
                <button class="btn" onclick={() => learningGate.reject(it.uid, it.detail)}>拒绝</button>
              {:else}
                <span class="tag">参考信息 · 不进世界书</span>
                <button class="btn" onclick={() => learningGate.reject(it.uid, it.detail)}>知道了</button>
              {/if}
            {/snippet}
          </SettingRow>
        {/each}
      </SettingGroup>
    {/if}

    {#if learningGate.notice}
      <p class="hint">{learningGate.notice}</p>
    {/if}

    <!-- 已落盘区：撤销是**显式动作**（M3 / C-08：关 flag 不会删这些条目） -->
    {#if learningGate.applied.length > 0}
      <SettingGroup title={`已写入世界书 · ${learningGate.applied.length} 条`}>
        {#each learningGate.applied as a (a.uid)}
          <SettingRow label={a.text.slice(0, 60)} desc={`《${a.target.book}》· 撤销即从该书移除`} stacked>
            {#snippet trailing()}
              <button
                class="btn"
                disabled={learningGate.writing}
                onclick={() => learningGate.revert(a.uid)}
              >
                撤销
              </button>
            {/snippet}
          </SettingRow>
        {/each}
      </SettingGroup>
    {/if}
  </div>
</SubPage>

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    padding-bottom: var(--gap-lg);
  }
  .boundary {
    margin: 0;
    padding: var(--gap-md) var(--gap-lg);
    border-radius: var(--radius-2xl);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    font-size: 0.74rem;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm);
  }
  .hint {
    margin: 0;
    padding: 0 4px;
    font-size: 0.74rem;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .hint.err {
    color: var(--danger);
  }
  .edit {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    outline: none;
  }
  .edit:focus {
    border-color: var(--accent-border);
  }
  .pick {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    outline: none;
  }
  .tag {
    align-self: center;
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
