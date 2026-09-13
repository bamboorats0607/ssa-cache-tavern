<script lang="ts">
  /**
   * 使用情况统计（设置 → 使用情况）。
   *
   * ── 三层隔离（用户明确要求）──────────────────────────────────────────────
   *   全部  →  角色（该角色所有会话）  →  角色单会话
   * 用 scope 表达，聚合口径由 `usage-aggregate.ts` 的纯函数统一保证，
   * 三层不会出现「换个视角数字对不上」的问题。
   *
   * ── 信息层级（数据杂志风）────────────────────────────────────────────────
   *   1) 主数字（命中率）—— 大号、唯一视觉焦点
   *   2) 次级指标条 —— 输入 / 输出 / 缓存 / 耗时，等宽对齐
   *   3) 折线图 —— 可切换指标，观察逐轮走势
   *   4) 明细 —— 角色分布 / 会话列表 / 逐轮完整 usage
   *
   * ── 诚实原则 ─────────────────────────────────────────────────────────────
   * · 会话级数据来自本地记录（localStorage），**不是**后端账单；
   * · 估算值明确标「估」，不与 API 实测混为一谈；
   * · 角色以**名称**为隔离键（上游无角色 id），同名角色会归并 —— 显式提示。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import LineChart from '../../lib/LineChart.svelte';
  import {
    aggregate,
    metricValue,
    METRICS,
    type MetricKey,
    type Scope,
  } from '../../lib/usage-aggregate';
  import { sessions } from '../../stores/sessions.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  /** 筛选层级：全部 / 角色 / 单会话 */
  let scopeKind = $state<'all' | 'character' | 'session'>('all');
  let characterName = $state<string | null>(null);
  let sessionId = $state<string | null>(null);
  /** 折线当前指标 */
  let metric = $state<MetricKey>('input');
  /** 展开逐轮明细 */
  let showTurns = $state(false);

  /** 已有的角色名（去重，按会话量降序由聚合结果给出） */
  const characterNames = $derived(
    [...new Set(sessions.list.map((s) => s.characterName))],
  );

  const scope = $derived<Scope>(
    scopeKind === 'all'
      ? { kind: 'all' }
      : scopeKind === 'character' && characterName
        ? { kind: 'character', characterName }
        : scopeKind === 'session' && sessionId
          ? { kind: 'session', sessionId }
          : { kind: 'all' },
  );

  const agg = $derived(aggregate(sessions.list, scope));

  const chartPoints = $derived(
    agg.series.map((p) => ({
      index: p.index,
      value: metricValue(p, metric),
      hint: new Date(p.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    })),
  );

  const metricDef = $derived(METRICS.find((m) => m.key === metric)!);

  // —— 格式化 ——
  const nf = new Intl.NumberFormat('en-US');
  const fmt = (n: number) => nf.format(Math.round(n));
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
  function dateOf(ts: number | null): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** 切到某角色视角 */
  function pickCharacter(name: string) {
    scopeKind = 'character';
    characterName = name;
    sessionId = null;
  }
  /** 切到某会话视角 */
  function pickSession(id: string) {
    scopeKind = 'session';
    sessionId = id;
  }
  function backToAll() {
    scopeKind = 'all';
    characterName = null;
    sessionId = null;
  }

  const scopeLabel = $derived(
    scopeKind === 'all'
      ? '全部'
      : scopeKind === 'character'
        ? `角色 · ${characterName ?? ''}`
        : `会话 · ${agg.bySession[0]?.title ?? sessions.list.find((s) => s.id === sessionId)?.title ?? ''}`,
  );
</script>

<SubPage title="使用情况" {onBack}>
  {#if sessions.list.length === 0}
    <!-- 无数据：明确说明为什么空，而不是画一个空图 -->
    <SettingGroup>
      <SettingRow label="还没有用量记录" desc="发起一次对话后，这里会统计输入 / 输出 / 缓存命中" />
    </SettingGroup>
    <section class="note">
      <p>
        统计数据来自本机记录（localStorage），<strong>不是</strong>服务商账单。
        它反映的是本应用的请求构成，用于观察缓存是否生效。
      </p>
    </section>
  {:else}
    <!-- ══ 筛选层级 ══ -->
    <div class="crumbs" role="navigation" aria-label="统计范围">
      <button class="crumb" class:active={scopeKind === 'all'} onclick={backToAll}>全部</button>
      {#if scopeKind !== 'all'}
        <span class="sep" aria-hidden="true">›</span>
        <button
          class="crumb"
          class:active={scopeKind === 'character'}
          onclick={() => characterName && pickCharacter(characterName)}
        >
          {characterName}
        </button>
      {/if}
      {#if scopeKind === 'session'}
        <span class="sep" aria-hidden="true">›</span>
        <span class="crumb active" aria-current="page">{scopeLabel}</span>
      {/if}
    </div>

    <!-- ══ 主数字：命中率（唯一视觉焦点）══ -->
    <section class="hero glass">
      <div class="hero-main">
        <div class="hero-value">
          {pct(agg.totals.hitRate)}
        </div>
        <div class="hero-label">缓存命中率</div>
      </div>
      <div class="hero-side">
        <div class="hero-side-row">
          <span class="k">命中</span><span class="v accent">{fmt(agg.totals.cached)}</span>
        </div>
        <div class="hero-side-row">
          <span class="k">计费输入</span><span class="v">{fmt(agg.totals.missed)}</span>
        </div>
        <div class="hero-side-note">命中部分按缓存价计费</div>
      </div>
    </section>

    <!-- ══ 次级指标 ══ -->
    <section class="tiles">
      <div class="tile">
        <div class="tile-k">输入</div>
        <div class="tile-v">{fmt(agg.totals.input)}</div>
        <div class="tile-sub">均 {fmt(agg.totals.avgInput)}/轮</div>
      </div>
      <div class="tile">
        <div class="tile-k">输出</div>
        <div class="tile-v">{fmt(agg.totals.output)}</div>
        <div class="tile-sub">均 {fmt(agg.totals.avgOutput)}/轮</div>
      </div>
      <div class="tile">
        <div class="tile-k">轮次</div>
        <div class="tile-v">{fmt(agg.totals.turns)}</div>
        <div class="tile-sub">{agg.totals.sessions} 个会话</div>
      </div>
      <div class="tile">
        <div class="tile-k">平均耗时</div>
        <div class="tile-v">{ms(agg.totals.avgDurationMs)}</div>
        <div class="tile-sub">总 {ms(agg.totals.avgDurationMs * agg.totals.turns)}</div>
      </div>
    </section>

    <!-- ══ 折线图 ══ -->
    <section class="chart-card glass">
      <div class="chart-head">
        <div class="chart-title">
          <span class="ct-label">逐轮走势</span>
          <span class="ct-sub">{scopeLabel}</span>
        </div>
        <div class="metric-tabs" role="tablist" aria-label="指标">
          {#each METRICS as m (m.key)}
            <button
              class="mtab"
              class:active={metric === m.key}
              role="tab"
              aria-selected={metric === m.key}
              onclick={() => (metric = m.key)}
            >
              {m.label}
            </button>
          {/each}
        </div>
      </div>

      <LineChart
        points={chartPoints}
        unit={metricDef.unit}
        thousandSeparator={!metricDef.ratio && metric !== 'durationMs'}
        height={190}
        emptyHint="当前范围没有轮次"
      />
    </section>

    <!-- ══ 维度：角色分布 ══ -->
    {#if scopeKind === 'all' && agg.byCharacter.length > 0}
      <SettingGroup title="按角色">
        {#each agg.byCharacter as r (r.characterName)}
          <button class="roll-row" onclick={() => pickCharacter(r.characterName)}>
            <span class="rr-main">
              <span class="rr-name">{r.characterName}</span>
              <span class="rr-meta">{r.sessions} 会话 · {r.turns} 轮</span>
            </span>
            <span class="rr-stats">
              <span class="rr-hit" class:on={r.hitRate > 0}>{pct(r.hitRate)}</span>
              <span class="rr-tok">{fmt(r.input)} tok</span>
            </span>
          </button>
        {/each}
      </SettingGroup>
    {/if}

    <!-- ══ 维度：会话列表（角色视角 / 会话视角）══ -->
    {#if scopeKind !== 'all' && agg.bySession.length > 0}
      <SettingGroup title={scopeKind === 'character' ? '该角色的会话' : '会话'}>
        {#each agg.bySession as s (s.id)}
          <button
            class="roll-row"
            class:current={s.id === sessionId}
            onclick={() => pickSession(s.id)}
          >
            <span class="rr-main">
              <span class="rr-name">{s.title}</span>
              <span class="rr-meta">{s.turns} 轮 · {dateOf(s.updatedAt)}</span>
            </span>
            <span class="rr-stats">
              <span class="rr-hit" class:on={s.hitRate > 0}>{pct(s.hitRate)}</span>
              <span class="rr-tok">{fmt(s.input)} tok</span>
            </span>
          </button>
        {/each}
      </SettingGroup>
    {/if}

    <!-- ══ 逐轮完整 usage 明细 ══ -->
    <SettingGroup title="明细">
      <SettingRow
        label="逐轮记录"
        desc={`共 ${agg.totals.turns} 轮 · 实测 ${agg.totals.measuredTurns} / 估算 ${agg.totals.estimatedTurns}`}
        value={showTurns ? '收起' : '展开'}
        onclick={() => (showTurns = !showTurns)}
      />
    </SettingGroup>

    {#if showTurns}
      <div class="turns">
        {#each [...agg.turns].reverse() as t (t.id)}
          <div class="turn glass">
            <div class="turn-head">
              <span class="turn-round">#{t.round}</span>
              <span class="turn-time">{dateOf(t.at)}</span>
              <span class="turn-model">{t.model}</span>
            </div>
            <div class="turn-text">
              <div class="tt-row"><span class="tt-k">问</span><span class="tt-v">{t.userText}</span></div>
              <div class="tt-row"><span class="tt-k">答</span><span class="tt-v">{t.assistantText}</span></div>
            </div>
            <!-- 完整 usage：输入 / 输出 / 缓存 / 命中率 / 耗时 -->
            <div class="turn-usage">
              <span class="tu">
                <span class="tu-k">输入</span>
                <span class="tu-v">{fmt(t.stats.inputTokens)}</span>
                {#if !t.stats.inputMeasured}<span class="tu-est">估</span>{/if}
              </span>
              <span class="tu">
                <span class="tu-k">输出</span><span class="tu-v">{fmt(t.stats.outputTokens)}</span>
              </span>
              <span class="tu" class:hot={t.stats.cachedTokens > 0}>
                <span class="tu-k">缓存</span><span class="tu-v">{fmt(t.stats.cachedTokens)}</span>
                {#if t.stats.cachedTokens > 0}
                  <span class="tu-rate">
                    {pct(t.stats.cachedTokens / Math.max(1, t.stats.inputTokens))}
                  </span>
                {/if}
              </span>
              <span class="tu">
                <span class="tu-k">耗时</span><span class="tu-v">{ms(t.durationMs)}</span>
              </span>
            </div>
            <!-- 组装分解（内核注入来源） -->
            <div class="turn-break">
              前缀 {t.stats.breakdown.prefix} · 尾缀 {t.stats.breakdown.suffix} ·
              簇 {t.stats.breakdown.liveClusters} · 事实槽 {t.stats.breakdown.facts} ·
              检索叶 {t.stats.breakdown.leaf}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- ══ 说明与清理 ══ -->
    <section class="note">
      <p>
        数据来自本机记录（localStorage），<strong>不是</strong>服务商账单。
        标「估」的轮次为本地估算（上游未返回 usage）。
        角色以<strong>名称</strong>隔离 —— 上游角色卡无唯一 id，同名角色会归并。
      </p>
    </section>

    <button
      class="danger"
      onclick={() => {
        if (confirm('清空全部会话与用量记录？此操作不可撤销。')) {
          sessions.clear();
          backToAll();
        }
      }}
    >
      清空用量记录
    </button>
  {/if}
</SubPage>

<style>
  /* ── 面包屑（筛选层级）── */
  .crumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    padding: 0 2px;
  }
  .crumb {
    border: none;
    background: transparent;
    padding: 4px 8px;
    border-radius: var(--radius-md);
    font-family: inherit;
    font-size: 0.76rem;
    font-weight: 600;
    color: var(--text-dim);
    cursor: pointer;
    max-width: 46vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .crumb:hover {
    background: var(--neutral-1);
    color: var(--text-muted);
  }
  .crumb.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .sep {
    color: var(--text-faint);
    font-size: 0.8rem;
  }

  /* ── 主数字（唯一视觉焦点）── */
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-lg);
    padding: var(--gap-xl) var(--gap-lg);
    border-radius: var(--radius-2xl);
    flex-wrap: wrap;
  }
  .hero-value {
    font-size: 3.2rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.045em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .hero-label {
    margin-top: 6px;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .hero-side {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 132px;
  }
  .hero-side-row {
    display: flex;
    justify-content: space-between;
    gap: var(--gap-md);
    font-size: 0.78rem;
  }
  .hero-side-row .k {
    color: var(--text-dim);
  }
  .hero-side-row .v {
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .hero-side-row .v.accent {
    color: var(--accent);
  }
  .hero-side-note {
    margin-top: 2px;
    padding-top: 6px;
    border-top: 1px solid var(--neutral-2);
    font-size: 0.62rem;
    color: var(--text-faint);
    line-height: 1.4;
  }

  /* ── 次级指标 ── */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--gap-sm);
  }
  .tile {
    padding: var(--gap-md) var(--gap-lg);
    border-radius: var(--radius-xl);
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(var(--blur-intensity));
  }
  .tile-k {
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .tile-v {
    margin-top: 4px;
    font-size: 1.32rem;
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .tile-sub {
    margin-top: 2px;
    font-size: 0.64rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ── 图表卡片 ── */
  .chart-card {
    border-radius: var(--radius-2xl);
    padding: var(--gap-lg);
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
  }
  .chart-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--gap-md);
    flex-wrap: wrap;
  }
  .chart-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ct-label {
    font-size: 0.86rem;
    font-weight: 700;
    color: var(--text);
  }
  .ct-sub {
    font-size: 0.66rem;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 42vw;
  }
  /* 指标切换：小药丸，当前项实心 */
  .metric-tabs {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
    padding: 3px;
    border-radius: var(--radius-pill);
    background: var(--neutral-1);
  }
  .mtab {
    border: none;
    background: transparent;
    padding: 5px 10px;
    border-radius: var(--radius-pill);
    font-family: inherit;
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .mtab:hover {
    color: var(--text-muted);
  }
  .mtab.active {
    background: var(--accent);
    color: var(--on-accent);
  }

  /* ── 汇总行（角色 / 会话）── */
  .roll-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-md);
    width: 100%;
    padding: 13px var(--gap-lg);
    border: none;
    background: transparent;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .roll-row:hover {
    background: var(--neutral-1);
  }
  .roll-row.current {
    background: var(--accent-soft);
  }
  .rr-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .rr-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rr-meta {
    font-size: 0.68rem;
    color: var(--text-dim);
  }
  .rr-stats {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    flex-shrink: 0;
  }
  .rr-hit {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .rr-hit.on {
    color: var(--accent);
  }
  .rr-tok {
    font-size: 0.64rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ── 逐轮明细 ── */
  .turns {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    max-height: 62vh;
    overflow-y: auto;
  }
  .turn {
    border-radius: var(--radius-xl);
    padding: var(--gap-md) var(--gap-lg);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .turn-head {
    display: flex;
    align-items: baseline;
    gap: var(--gap-sm);
    font-size: 0.66rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .turn-round {
    font-weight: 700;
    color: var(--accent);
  }
  .turn-model {
    margin-left: auto;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }
  .turn-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .tt-row {
    display: flex;
    gap: 7px;
    font-size: 0.76rem;
    line-height: 1.5;
  }
  .tt-k {
    flex-shrink: 0;
    width: 15px;
    color: var(--text-faint);
    font-weight: 600;
  }
  .tt-v {
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .turn-usage {
    display: flex;
    flex-wrap: wrap;
    gap: 11px;
    padding-top: 6px;
    border-top: 1px solid var(--neutral-2);
    font-size: 0.66rem;
  }
  .tu {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    white-space: nowrap;
  }
  .tu-k {
    color: var(--text-faint);
  }
  .tu-v {
    font-weight: 600;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .tu.hot .tu-v,
  .tu.hot .tu-rate {
    color: var(--accent);
  }
  .tu-rate {
    font-weight: 700;
  }
  .tu-est {
    font-size: 0.56rem;
    opacity: 0.6;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 2px;
    color: var(--text-faint);
    line-height: 1.2;
  }
  .turn-break {
    font-size: 0.6rem;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  /* ── 说明与危险操作 ── */
  .note {
    border-radius: var(--radius-2xl);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    padding: var(--gap-lg);
  }
  .note p {
    margin: 0;
    font-size: 0.7rem;
    color: var(--text-muted);
    line-height: 1.65;
  }
  .note strong {
    color: var(--text);
    font-weight: 700;
  }
  .danger {
    padding: 13px;
    border-radius: var(--radius-2xl);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    background: transparent;
    color: var(--danger);
    font-family: inherit;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .danger:hover {
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
</style>
