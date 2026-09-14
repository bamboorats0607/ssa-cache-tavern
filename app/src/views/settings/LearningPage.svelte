<script lang="ts">
  /**
   * 学习建议页（沙盒面板；spec §10 / T3.2）。// [SSA-LEARN]
   *
   * ── 形态纪律 ──────────────────────────────────────────────────────────────
   * · **列表 + 采纳/拒绝/编辑**，不是数值面板（R-08）：θ / minFreq / window /
   *   置信度数字一律不显示；每条只给「哪一类 / 来自哪条通道 / 正文」。
   *   （唯一例外：**配额余量**是 spec §10 明令的可观测项。）
   * · 零建议空态、降级态、运行中态**都内联渲染**，不用弹窗（R-11）。
   * · 「采纳」= 真的写进**学习副本**（C-06：写入范围 ⊆ {副本}）；写入失败当场说明
   *   且不改本机记录（R8）；已写入的条目在本页可**显式撤销**或**一键整体回滚**。
   * · 配额触顶 → **显性暂停横幅**（禁静默丢弃）。
   * · 观测性产物（场景触发 / 词对耦合 / 名称归并）没有可注入正文 → 不给「采纳」，
   *   只显示为参考（避免「采纳了却什么都没发生」）。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import { onMount } from 'svelte';
  import { learningGate } from '../../lib/learning/suggest-gate.svelte';
  import { isAppliable } from '../../lib/learning/copy-core';
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
  const sandbox = $derived(learningGate.sandbox);
  const copyState = $derived(learningGate.copyState);
  const quota = $derived(learningGate.quota);
  const delta = $derived(learningGate.delta);

  // 拉一次世界书列表（沙盒要克隆「当前启用」的书）；失败不阻塞本页（降级后端没有该接口）
  onMount(() => {
    if (!worldbook.loaded) void worldbook.load();
  });

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
    <!-- 边界声明：产物只进副本，原书自克隆起不进写入路径（C-06 / R-02 / spec §10） -->
    <p class="boundary">
      学习产物<strong>只写进学习副本</strong>：点下面的按钮会把你当前启用的世界书
      <strong>原样复制</strong>一份（含本 App 不认识的字段），此后所有产物都只落进副本，
      <strong>原书</strong>自克隆那一刻起不再被改动。副本可整体回滚、可删除、可随时切回源书；
      关掉学习开关<strong>不会</strong>删除副本里的条目。
    </p>

    {#if worldbook.activationNote}
      <p class="hint err">{worldbook.activationNote}</p>
    {/if}

    <SettingGroup title="学习副本（沙盒）">
      {#if !sandbox}
        <SettingRow
          label="创建并启用副本"
          desc="把当前启用的世界书原样复制一份作为副本，并把副本设为启用书；学习只写它"
          stacked
        >
          {#snippet trailing()}
            <div class="actions">
              <button
                class="btn btn-accent"
                disabled={learningGate.writing || !worldbook.activeName}
                onclick={() => learningGate.enableSandbox()}
              >
                创建并启用副本
              </button>
              <button class="btn" onclick={() => void worldbook.load(true)}>刷新书单</button>
            </div>
            <p class="hint">
              {worldbook.activeName
                ? `将以《${worldbook.activeName}》为源书创建副本（副本名 = 源书名 + 「·学习副本」）。`
                : '当前没有启用的世界书——先在世界书页启用一本，再回来创建副本。'}
            </p>
            {#if worldbook.lastError}
              <p class="hint err">世界书列表读取失败：{worldbook.lastError}</p>
            {/if}
          {/snippet}
        </SettingRow>
      {:else}
        <SettingRow
          label={`副本《${sandbox.copyName}》`}
          value={learningGate.copyActive ? '已启用' : '未启用'}
          desc={`源书《${sandbox.sourceName}》· 克隆基线：${
            sandbox.clonedAt ? sandbox.clonedAt.replace('T', ' ').slice(0, 16) : '未记录'
          }`}
          stacked
        >
          {#snippet trailing()}
            <div class="actions">
              {#if !learningGate.copyActive}
                <button
                  class="btn btn-accent"
                  disabled={learningGate.writing}
                  onclick={() => learningGate.activateCopy()}
                >
                  启用副本
                </button>
              {/if}
              <button
                class="btn"
                disabled={learningGate.writing}
                onclick={() => learningGate.switchBackToSource()}
              >
                切回源书
              </button>
              <button
                class="btn"
                disabled={learningGate.writing}
                onclick={() => learningGate.refreshCopyState()}
              >
                刷新状态
              </button>
              <button
                class="btn"
                disabled={learningGate.writing}
                onclick={() => learningGate.deleteCopy()}
              >
                删除副本
              </button>
            </div>
            {#if !learningGate.copyActive}
              <p class="hint warn">
                副本<strong>不是</strong>当前启用的世界书——此时写副本会被拒绝（会写进一本不被注入的书）。
                点「启用副本」切过去，或「切回源书」回到原书。
              </p>
            {/if}
          {/snippet}
        </SettingRow>

        {#if copyState?.error}
          <SettingRow label="副本状态" value={`读取失败：${copyState.error}`} stacked />
        {:else if quota}
          <SettingRow
            label="配额余量"
            value={`候选簇 ${quota.cluster}/${quota.limitCluster} · 模板行 ${quota.template}/${quota.limitTemplate}`}
            desc="触顶会显性暂停写入，不会静默丢弃"
          />
          {#if copyState}
            <SettingRow label="副本里的学习条目" value={`${copyState.learnedTotal} 条`} />
          {/if}
          {#if delta}
            <SettingRow
              label="相对克隆快照的增量"
              value={`学习追加 ${delta.addedByLearning} · 你手增 ${delta.addedByUser} · 手改 ${delta.edited} · 删除 ${delta.removed}${
                delta.renumbered ? ` · 重编号 ${delta.renumbered}` : ''
              }`}
              stacked
            />
          {/if}
        {/if}

        <SettingRow
          label="整体回滚"
          desc="摘除副本里全部学习条目（你手写/手改的条目不动）；「学歪了」时一键复原"
          stacked
        >
          {#snippet trailing()}
            <button
              class="btn"
              disabled={learningGate.writing || !learningGate.copyActive || !copyState}
              onclick={() => learningGate.rollbackAll()}
            >
              整体回滚
            </button>
          {/snippet}
        </SettingRow>
      {/if}
    </SettingGroup>

    <!-- 配额触顶：显性暂停横幅（禁静默丢弃，spec §10 / LG-16） -->
    {#if quota?.paused}
      <p class="banner">⏸ {quota.reason}</p>
    {/if}

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
          desc={`${
            learningGate.lastRunInfo.character
              ? `只学《${learningGate.lastRunInfo.character}》的会话（其它角色的语料不参与）`
              : '没有正在进行的会话，本次学的是本机全部单角色会话'
          }（本机共 ${learningGate.lastRunInfo.allSessions} 个对话）${
            learningGate.lastRunInfo.droppedEmpty
              ? ` · 跳过 ${learningGate.lastRunInfo.droppedEmpty} 轮空文本`
              : ''
          }`}
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

    <!-- 已落盘区：撤销是**显式动作**（C-08：关 flag 不会删这些条目） -->
    {#if learningGate.applied.length > 0}
      <SettingGroup title={`已写入副本 · ${learningGate.applied.length} 条`}>
        {#each learningGate.applied as a (a.uid)}
          <SettingRow
            label={a.text.slice(0, 60)}
            desc={`《${a.target.book}》· 撤销即从该书摘除这一条`}
            stacked
          >
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
  .hint.warn {
    color: var(--text);
    padding: 0;
  }
  /* 配额触顶横幅：比 hint 更显眼，避免「以为还在学、其实早就没写」 */
  .banner {
    margin: 0;
    padding: var(--gap-md) var(--gap-lg);
    border-radius: var(--radius-2xl);
    border: 1px solid var(--danger);
    background: var(--neutral-1);
    font-size: 0.76rem;
    line-height: 1.6;
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
  .tag {
    align-self: center;
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
