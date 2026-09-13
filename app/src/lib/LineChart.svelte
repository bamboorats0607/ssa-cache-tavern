<script lang="ts">
  /**
   * 折线图（零依赖，手写 SVG）。
   *
   * ── 为什么手写而不引库 ────────────────────────────────────────────────────
   * 项目 `dependencies` 为空，且 APK 体积敏感（ECharts ≈ 1MB、Chart.js ≈ 200KB）。
   * 本组件只需「一条折线 + 网格 + 悬停读数」，手写 SVG 约 200 行即可覆盖，
   * 且渲染成本与包体都为最优。
   *
   * ── 设计（数据杂志风）────────────────────────────────────────────────────
   * · 网格用**极细虚线**，只作为读数辅助，不与数据争夺注意力
   * · 折线用 2px 圆头描边 + 微妙面积渐变（同色 16% → 0）
   * · 端点与悬停点用实心圆，配十字准线
   * · Y 轴刻度取「好看的数」（1/2/5 × 10^n），而不是原始最大值的零头
   */

  /** 数据结构：由调用方传入（与 usage-aggregate 的 SeriesPoint 解耦，便于复用）。
   *  注：Svelte 组件不能向外导出类型，故此类型仅供本组件内部使用；
   *  外部若需复用请从 `usage-aggregate.ts` 取 SeriesPoint。 */
  interface Point {
    /** X 轴序号（用于读数） */
    index: number;
    /** 数值 */
    value: number;
    /** 悬停浮层里的补充说明（可选） */
    hint?: string;
  }

  interface Props {
    points: Point[];
    /** 数值单位（读数与 Y 轴用） */
    unit?: string;
    /** 是否千分位（token 类用 true，百分比/毫秒用 false） */
    thousandSeparator?: boolean;
    /** 高度（px） */
    height?: number;
    /** 空数据时的提示语 */
    emptyHint?: string;
  }

  let {
    points,
    unit = '',
    thousandSeparator = true,
    height = 180,
    emptyHint = '暂无数据',
  }: Props = $props();

  /** SVG 内部坐标系（viewBox）：宽 1000 高 320，按容器拉伸，避免依赖真实像素测量 */
  const VB_W = 1000;
  const VB_H = 320;
  /** 绘图区内边距（给 Y 轴标签与端点留空间） */
  const PAD = { top: 18, right: 16, bottom: 26, left: 52 };

  const plotW = VB_W - PAD.left - PAD.right;
  const plotH = VB_H - PAD.top - PAD.bottom;

  let hoverIdx = $state<number | null>(null);

  /**
   * 取「好看的」Y 轴上限：把最大值向上取到 1/2/5 × 10^n。
   * 直接用原始最大值会让刻度出现 1237 这类难读的数。
   */
  function niceCeil(v: number): number {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const norm = v / base;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * base;
  }

  const maxValue = $derived(points.length ? Math.max(...points.map((p) => p.value)) : 0);
  const yMax = $derived(niceCeil(maxValue));

  /** 坐标换算：数据点 → SVG 坐标 */
  function xAt(i: number): number {
    if (points.length <= 1) return PAD.left + plotW / 2;
    return PAD.left + (i / (points.length - 1)) * plotW;
  }
  function yAt(v: number): number {
    const r = yMax > 0 ? v / yMax : 0;
    return PAD.top + plotH - r * plotH;
  }

  /** 折线路径（单点时不画线，只画点） */
  const linePath = $derived(
    points.length < 2
      ? ''
      : points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(p.value).toFixed(2)}`).join(' '),
  );

  /** 面积路径（折线下方闭合） */
  const areaPath = $derived(
    points.length < 2
      ? ''
      : `${linePath} L ${xAt(points.length - 1).toFixed(2)} ${(PAD.top + plotH).toFixed(2)} L ${xAt(0).toFixed(2)} ${(PAD.top + plotH).toFixed(2)} Z`,
  );

  /** Y 轴刻度（5 档，含 0 与上限） */
  const yTicks = $derived(
    Array.from({ length: 5 }, (_, i) => {
      const v = (yMax / 4) * i;
      return { v, y: yAt(v) };
    }),
  );

  /** X 轴标签：最多 6 个，避免密集重叠 */
  const xTicks = $derived.by(() => {
    const n = points.length;
    if (n === 0) return [];
    const maxTicks = 6;
    const gap = Math.max(1, Math.ceil(n / maxTicks));
    const out: { i: number; x: number; label: string }[] = [];
    for (let i = 0; i < n; i += gap) {
      out.push({ i, x: xAt(i), label: `#${points[i].index}` });
    }
    // 保证末点有标签（否则看不出范围）
    const last = n - 1;
    if (out[out.length - 1]?.i !== last) {
      out.push({ i: last, x: xAt(last), label: `#${points[last].index}` });
    }
    return out;
  });

  function fmt(n: number): string {
    const s = Math.round(n).toString();
    return thousandSeparator ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
  }

  /** 悬停：由鼠标 X 位置反算最近的数据点下标 */
  function onMove(e: MouseEvent) {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (rect.width === 0 || points.length === 0) return;
    // 屏幕坐标 → viewBox 坐标
    const vbX = ((e.clientX - rect.left) / rect.width) * VB_W;
    const t = (vbX - PAD.left) / plotW;
    const i = points.length <= 1 ? 0 : Math.round(t * (points.length - 1));
    hoverIdx = Math.max(0, Math.min(points.length - 1, i));
  }

  const hoverPoint = $derived(hoverIdx === null ? null : points[hoverIdx]);
</script>

<div class="chart" style="--chart-h:{height}px">
  {#if points.length === 0}
    <div class="empty">{emptyHint}</div>
  {:else}
    <svg
      class="plot"
      viewBox="0 0 {VB_W} {VB_H}"
      preserveAspectRatio="none"
      role="img"
      aria-label={`折线图，共 ${points.length} 个数据点`}
      onmousemove={onMove}
      onmouseleave={() => (hoverIdx = null)}
    >
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.16" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- 网格：极细虚线，仅作读数辅助 -->
      {#each yTicks as t}
        <line class="grid" x1={PAD.left} y1={t.y} x2={VB_W - PAD.right} y2={t.y} />
      {/each}

      <!-- Y 轴刻度值 -->
      {#each yTicks as t}
        <text class="axis-y" x={PAD.left - 10} y={t.y + 5} text-anchor="end">
          {fmt(t.v)}
        </text>
      {/each}

      <!-- 面积 + 折线（单点时只画点） -->
      {#if points.length > 1}
        <path class="area" d={areaPath} />
        <path class="line" d={linePath} />
      {/if}

      <!-- 数据点 -->
      {#each points as p, i (p.index)}
        <circle
          class="dot"
          class:dim={points.length > 30}
          cx={xAt(i)}
          cy={yAt(p.value)}
          r={points.length > 30 ? 2.5 : 4}
        />
      {/each}

      <!-- 悬停准线 -->
      {#if hoverIdx !== null && hoverPoint}
        <line
          class="crosshair"
          x1={xAt(hoverIdx)}
          y1={PAD.top}
          x2={xAt(hoverIdx)}
          y2={PAD.top + plotH}
        />
        <circle
          class="hover-dot"
          cx={xAt(hoverIdx)}
          cy={yAt(hoverPoint.value)}
          r="7"
        />
      {/if}

      <!-- X 轴标签 -->
      {#each xTicks as t (t.i)}
        <text class="axis-x" x={t.x} y={VB_H - 8} text-anchor="middle">{t.label}</text>
      {/each}
    </svg>

    <!-- 悬停读数：放在图外，避免遮挡曲线 -->
    <div class="readout" class:show={hoverPoint !== null}>
      {#if hoverPoint}
        <span class="ro-index">#{hoverPoint.index}</span>
        <span class="ro-value">{fmt(hoverPoint.value)}<span class="ro-unit">{unit}</span></span>
        {#if hoverPoint.hint}<span class="ro-hint">{hoverPoint.hint}</span>{/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
    height: var(--chart-h);
    display: flex;
    flex-direction: column;
  }
  .empty {
    margin: auto;
    font-size: 0.75rem;
    color: var(--text-faint);
    letter-spacing: 0.02em;
  }
  .plot {
    width: 100%;
    height: 100%;
    display: block;
    overflow: visible;
  }

  .grid {
    stroke: var(--neutral-3);
    stroke-width: 1;
    stroke-dasharray: 3 5;
    vector-effect: non-scaling-stroke;
  }
  .area {
    fill: url(#areaFill);
  }
  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .dot {
    fill: var(--accent);
    stroke: var(--bg-root);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  /* 点多时缩小，避免糊成一片 */
  .dot.dim {
    stroke-width: 1;
    opacity: 0.75;
  }
  .crosshair {
    stroke: var(--accent);
    stroke-width: 1;
    stroke-dasharray: 2 3;
    opacity: 0.5;
    vector-effect: non-scaling-stroke;
  }
  .hover-dot {
    fill: var(--accent);
    stroke: var(--bg-root);
    stroke-width: 3;
    vector-effect: non-scaling-stroke;
  }

  .axis-y,
  .axis-x {
    font-size: 20px;
    font-family: var(--font-mono);
    fill: var(--text-faint);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  /* 悬停读数：绝对定位在图右上，不遮挡曲线 */
  .readout {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 3px 8px;
    border-radius: var(--radius-md);
    background: var(--glass-bg-active);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(8px);
    font-size: 0.7rem;
    opacity: 0;
    transform: translateY(-2px);
    transition: opacity var(--dur-fast) var(--ease-standard),
      transform var(--dur-fast) var(--ease-standard);
    pointer-events: none;
    white-space: nowrap;
  }
  .readout.show {
    opacity: 1;
    transform: translateY(0);
  }
  .ro-index {
    color: var(--text-faint);
    font-family: var(--font-mono);
  }
  .ro-value {
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .ro-unit {
    margin-left: 2px;
    font-size: 0.62rem;
    font-weight: 500;
    color: var(--text-dim);
  }
  .ro-hint {
    color: var(--text-dim);
    font-size: 0.64rem;
  }
</style>
