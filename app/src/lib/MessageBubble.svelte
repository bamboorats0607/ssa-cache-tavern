<script lang="ts">
  /**
   * 消息气泡。角色左 / 用户右，含 hover 操作按钮。
   * 视觉对齐 opentavern 的 .msg-bubble 语义（琥珀=用户，中性=角色）。
   */
  import type { TurnStats } from './chat-stats';
  import Avatar from './Avatar.svelte';

  interface Props {
    role: 'user' | 'assistant';
    text: string;
    /** 本轮用量统计（输入 / 输出 / 缓存命中） */
    stats?: TurnStats;
    /** 用户消息附带的图片（data URL 数组）；助手消息不使用 */
    images?: string[];
    /** 头像绝对 URL（已由 characterAvatarUrl() 解析）；缺省或加载失败时回退首字母 */
    avatarUrl?: string | null;
    /** 头像回退用的名字（取首字母） */
    avatarName?: string;
    /** 是否用户消息（决定菜单是否显示「改写并重新生成」） */
    canEditUser?: boolean;
    /** 是否助手消息（决定菜单是否显示「重新生成」） */
    canRegenerate?: boolean;
    /** 撤销此消息及其以下（由父组件注入实际行为） */
    onUndo?: () => void;
    /** 改写此用户消息并重新生成 */
    onRewrite?: () => void;
    /** 重新生成本条助手回复 */
    onRegenerate?: () => void;
  }
  let {
    role,
    text,
    stats,
    images,
    avatarUrl,
    avatarName,
    canEditUser,
    canRegenerate,
    onUndo,
    onRewrite,
    onRegenerate,
  }: Props = $props();

  let actionsVisible = $state(false);
  let copied = $state(false);
  /** 点击缩略图后的放大预览（存被点的 data URL，null = 关闭） */
  let zoomed = $state<string | null>(null);
  /** 长按 / 右键菜单是否展开 */
  let menuOpen = $state(false);
  /**
   * 菜单浮层元素（用于判断「点击菜单外」）。
   *
   * ⚠️ 必须是 $state：菜单在 `{#if menuOpen}` 里，切到 true 的**那一帧**元素还没挂载，
   * bind:this 稍后才赋值。若用普通变量，依赖它的 $effect 不会重跑，全局监听就会
   * 带着 undefined 的 menuEl 装上 → 「点击菜单外关闭」失效（点在菜单内也会关）。
   */
  let menuEl = $state<HTMLDivElement | undefined>(undefined);
  /** 消息根元素（测量菜单锚点位置用） */
  let wrapperEl: HTMLDivElement | undefined;
  /**
   * 菜单锚点坐标。
   * 用 fixed 而非 absolute：消息区 `.messages` 是 overflow:auto，absolute 浮层会被
   * 滚动容器裁剪（尤其最后一条消息）。fixed + 由 getBoundingClientRect 计算，
   * 视觉上仍相对该消息定位，且不会被裁剪。
   */
  let menuPos = $state<{ top: number; left: number } | null>(null);

  /** 长按定时器句柄（500ms 触发） */
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  /** 长按已触发后，抑制紧随其后的 click（避免误触气泡内元素） */
  let suppressClick = false;

  /** 命中率：缓存命中 token / 输入 token */
  const hitRate = $derived(
    stats && stats.inputTokens > 0 ? stats.cachedTokens / stats.inputTokens : 0,
  );

  /** 千分位 */
  function fmt(n: number): string {
    return n.toLocaleString('en-US');
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  // ── 菜单开关 ───────────────────────────────────────────────────────────
  /** 计算浮层坐标（fixed 定位，避免被滚动容器裁剪）。 */
  function openMenu() {
    const r = wrapperEl?.getBoundingClientRect();
    if (r) {
      // 菜单尺寸按经验值估算（min-width 168 + padding；约 4 行菜单）
      const MENU_W = 176;
      const MENU_H = 200;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 垂直：贴消息顶对齐，并夹在视口内
      const top = Math.max(8, Math.min(r.top, vh - MENU_H));
      // 水平：用户消息右对齐（菜单左移 100%）；助手消息左对齐。均做视口内夹取
      let left = role === 'user' ? r.right : r.left;
      left =
        role === 'user'
          ? Math.max(MENU_W + 8, left)
          : Math.min(left, vw - MENU_W - 8);
      menuPos = { top, left };
    }
    menuOpen = true;
  }
  function closeMenu() {
    menuOpen = false;
  }

  /**
   * 菜单项点击：先关菜单再执行回调。
   * 注意「删除」并入「撤销」语义 —— 用户消息撤销=丢弃该轮及其后，助手消息撤销=
   * 清空该回复及其后，二者对外已覆盖删除需求，故不再单独提供 onDelete。
   */
  function runAction(fn?: () => void) {
    closeMenu();
    fn?.();
  }

  // ── 移动端长按 ─────────────────────────────────────────────────────────
  function clearPressTimer() {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }
  function onTouchStart() {
    clearPressTimer();
    // 新一轮触摸开始：复位抑制标记（避免上一次长按后浏览器未派发 click 时记忆残留）
    suppressClick = false;
    // 500ms 长按触发；触发后抑制随后的 click（手指抬起时浏览器仍会派发 click）
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      openMenu();
    }, 500);
  }
  function onTouchMove() {
    // 手指移动 = 用户在滚动，取消长按
    clearPressTimer();
  }
  function onTouchEnd() {
    clearPressTimer();
    // click 紧随 touchend 派发，此处置位让 click 捕获阶段拦截后复位
  }
  function onClickCapture(e: MouseEvent) {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  }

  // ── 桌面端右键 ─────────────────────────────────────────────────────────
  function onContextMenu(e: MouseEvent) {
    // 阻止浏览器默认右键菜单（移动端 Android 长按也会走这里）
    e.preventDefault();
    openMenu();
  }

  /**
   * 菜单打开期间才挂全局监听：点击菜单外任意处 / Escape / 滚动消息区时关闭。
   * $effect 返回清理函数，关闭后监听自动移除，避免泄漏。
   */
  $effect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (menuEl && t && menuEl.contains(t)) return; // 菜单内部点击由菜单项自理
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onScroll = () => closeMenu();
    // 捕获阶段监听：滚动事件不冒泡，但可在 document 捕获到
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  });

  // ── 超长正文展开/收起（纯视图裁剪） ───────────────────────────────────
  /** 折叠行数阈值：正文超过这么多行，才提供「展开/收起」按钮 */
  const maxLines = 8;
  /**
   * 是否展开。
   *
   * 默认 **展开** —— 本产品核心是「读角色回复」，默认折叠正文属可用性倒退（见 Spec §2.1）。
   * 收起只是「减少立绘被遮挡」的可选手段，不是默认态。
   */
  let expanded = $state(true);
  /**
   * 正文元素（测高用）。
   *
   * ⚠️ 必须是 $state：正文在 `{#if text}` 内，切真的那一帧元素还没挂载，
   * bind:this 稍后才赋值。若用普通变量，依赖它的 $effect 不会重跑，
   * 测高就会带着上一帧的 undefined 结果（按钮显隐滞后）。原因同 menuEl。
   */
  let textEl = $state<HTMLDivElement | undefined>(undefined);
  /** 正文是否超过阈值（超过才渲染「展开全文」按钮） */
  let overflow = $state(false);

  /**
   * 测正文是否超过 maxLines 行。
   *
   * 用 scrollHeight 与阈值比较：即便当前处于折叠态（max-height 已生效），
   * scrollHeight 仍是内容完整高度，故切换展开/收起后判定不会抖动。
   * 阈值直接用 lh 单位换算不可靠（需读 computed line-height），
   * 这里用「单行高度 × maxLines」估算更稳（Chromium 的 computed lineHeight
   * 已经是 px 值，见实测）。
   */
  function measure() {
    const el = textEl;
    if (!el) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (!Number.isFinite(lh) || lh <= 0) return;
    // +1px 容差：避免恰好在整数倍行数时因亚像素舍入误判
    overflow = el.scrollHeight > lh * maxLines + 1;
  }

  /**
   * text 变化（重新生成 / 改写 / 换角色）后重测，否则按钮显隐会滞后。
   * $effect 在 DOM 更新后执行，故此处无需额外等待。
   */
  $effect(() => {
    void text;
    measure();
    // 换消息时复位为展开，避免沿用上一条的收起状态
    expanded = true;
  });

  /**
   * 切换展开/收起。
   *
   * ⚠️ 红线约束：只改变**视图高度**（max-height），绝不触碰 text 本身，
   * 也不把任何折叠态/截断文本写入 session store、buildContext 入参或其他
   * 进入 prompt 的字段。折叠 = 纯视图裁剪。
   */
  function toggleExpanded() {
    expanded = !expanded;
  }
</script>

<div
  class="msg-wrapper"
  class:msg-user={role === 'user'}
  class:msg-assistant={role === 'assistant'}
  bind:this={wrapperEl}
  role="group"
  aria-label={role === 'user' ? '我的消息' : '角色消息'}
  onmouseenter={() => (actionsVisible = true)}
  onmouseleave={() => (actionsVisible = false)}
  onfocusin={() => (actionsVisible = true)}
  onfocusout={() => (actionsVisible = false)}
  oncontextmenu={onContextMenu}
  ontouchstart={onTouchStart}
  ontouchmove={onTouchMove}
  ontouchend={onTouchEnd}
  ontouchcancel={clearPressTimer}
  onclickcapture={onClickCapture}
>
  <!-- 角色头像：仅助手消息。用户消息不显示头像（无对应角色） -->
  {#if role === 'assistant' && (avatarUrl || avatarName)}
    <Avatar src={avatarUrl} name={avatarName} size={32} />
  {/if}

  <div class="msg-body">
    <div class="msg-bubble">
      {#if images && images.length > 0}
        <div class="msg-images">
          {#each images as src, i (i)}
            <button
              type="button"
              class="msg-image-btn"
              onclick={() => (zoomed = src)}
              aria-label="查看图片"
            >
              <img {src} alt="附图 {i + 1}" loading="lazy" />
            </button>
          {/each}
        </div>
      {/if}
      {#if text}
        <div
          class="msg-text"
          class:clamped={!expanded}
          bind:this={textEl}
          style:max-height={expanded ? null : `${maxLines}lh`}
        >
          {text}
        </div>
      {/if}
    </div>

    {#if overflow}
      <button
        type="button"
        class="msg-toggle"
        onclick={toggleExpanded}
        aria-expanded={expanded}
      >
        {expanded ? '收起' : '展开全文'}
      </button>
    {/if}

    <!-- 用量标注：每条消息下方常驻（本轮发生了什么，一眼可见）
         用户消息只标「输入」（它没有输出），助手消息标「输出」并回看输入与缓存 -->
    {#if stats}
      <div class="msg-stats" aria-label="本轮 token 用量">
        {#if role === 'assistant'}
          <span class="stat" title="本轮输出 token（模型生成）">
            <span class="k">输出</span><span class="v">{fmt(stats.outputTokens)}</span>
          </span>
        {/if}
        <span class="stat" title="本轮输入 token（{stats.inputMeasured ? 'API 实测' : '本地估算'}）">
          <span class="k">输入</span><span class="v">{fmt(stats.inputTokens)}</span>
          {#if !stats.inputMeasured}<span class="est">估</span>{/if}
        </span>
        <span
          class="stat"
          class:hot={stats.cachedTokens > 0}
          title="输入中被缓存命中的 token（按缓存价计费，命中越多越省钱）"
        >
          <span class="k">缓存</span><span class="v">{fmt(stats.cachedTokens)}</span>
          {#if stats.cachedTokens > 0}
            <span class="rate">{(hitRate * 100).toFixed(0)}%</span>
          {/if}
        </span>
      </div>
    {/if}

    <div class="msg-actions" class:show={actionsVisible || copied}>
      <button class="msg-action-btn copy-btn" onclick={copy} title="复制" aria-label="复制">
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  </div>

  <!-- 长按 / 右键菜单浮层：玻璃风格小气泡，相对消息定位 -->
  {#if menuOpen}
    <div
      class="msg-menu glass"
      class:menu-user={role === 'user'}
      bind:this={menuEl}
      role="menu"
      aria-label="消息操作"
      tabindex="-1"
      style:top={menuPos ? `${menuPos.top}px` : '0'}
      style:left={menuPos ? `${menuPos.left}px` : '0'}
      onpointerdown={(e) => e.stopPropagation()}
    >
      <button class="menu-item" role="menuitem" onclick={() => runAction(copy)}>
        <span class="menu-ico" aria-hidden="true">⧉</span>
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      {#if canEditUser && onRewrite}
        <button class="menu-item" role="menuitem" onclick={() => runAction(onRewrite)}>
          <span class="menu-ico" aria-hidden="true">✎</span>
          <span>改写并重新生成</span>
        </button>
      {/if}
      {#if canRegenerate && onRegenerate}
        <button class="menu-item" role="menuitem" onclick={() => runAction(onRegenerate)}>
          <span class="menu-ico" aria-hidden="true">↻</span>
          <span>重新生成</span>
        </button>
      {/if}
      {#if onUndo}
        <button class="menu-item danger" role="menuitem" onclick={() => runAction(onUndo)}>
          <span class="menu-ico" aria-hidden="true">↺</span>
          <span>{role === 'user' ? '撤销此消息及以下' : '撤销此回复及以下'}</span>
        </button>
      {/if}
    </div>
  {/if}

  {#if zoomed}
    <button
      type="button"
      class="msg-zoom"
      onclick={() => (zoomed = null)}
      aria-label="关闭大图"
    >
      <img src={zoomed} alt="大图预览" />
    </button>
  {/if}
</div>

<style>
  .msg-wrapper {
    display: flex;
    flex-direction: column;
    max-width: min(680px, 88%);
    animation: fadeIn var(--dur-base) ease-out;
    /* 长按菜单：禁用 iOS 的「长按选中/弹出系统菜单」，避免与自定义菜单打架 */
    -webkit-touch-callout: none;
  }
  /* 桌面端：正文允许手动选中复制（细指针设备） */
  .msg-bubble {
    -webkit-user-select: text;
    user-select: text;
  }
  /* 触摸设备：禁选正文，防止长按触发原生文字选择与自定义菜单打架 */
  @media (hover: none) and (pointer: coarse) {
    .msg-wrapper,
    .msg-bubble {
      -webkit-user-select: none;
      user-select: none;
    }
  }
  .msg-user {
    align-self: flex-end;
    align-items: flex-end;
  }
  /* 助手消息：头像在左、正文在右（横排）。用户消息无头像，保持纵排 */
  .msg-assistant {
    align-self: flex-start;
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
  }
  /* 正文列：气泡 + 用量 + 操作按钮，三者都跟着左右缘对齐 */
  .msg-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .msg-user .msg-body {
    align-items: flex-end;
  }
  .msg-assistant .msg-body {
    align-items: flex-start;
  }

  /* 正文容器：只包正文（附图行在它之外）。
     折叠仅靠 max-height + overflow 裁剪，不写 -webkit- 前缀
     （构建期 LightningCSS 前缀归一会吞掉标准属性）。 */
  .msg-text {
    overflow: hidden;
  }
  /* 折叠态：底部渐隐由容器底色过渡实现，不引入额外纹理 */
  .msg-text.clamped {
    position: relative;
  }

  /* 展开/收起按钮：小、低对比，不抢正文视线 */
  .msg-toggle {
    margin-top: 6px;
    padding: 3px 12px;
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.04);
    color: var(--accent);
    font-family: inherit;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-start;
    -webkit-tap-highlight-color: transparent;
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .msg-toggle:hover {
    background: var(--accent-soft);
  }

  /* 用量标注：小字、低对比，不抢正文视线 */
  .msg-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 5px;
    padding: 0 4px;
    font-size: 0.66rem;
    line-height: 1.4;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .stat {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    white-space: nowrap;
  }
  .stat .k {
    opacity: 0.75;
  }
  .stat .v {
    font-weight: 600;
    color: var(--text-dim);
  }
  .stat .est {
    font-size: 0.58rem;
    opacity: 0.6;
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 2px;
    line-height: 1.2;
  }
  /* 有缓存命中时高亮 —— 这是省钱的正向信号 */
  .stat.hot .v,
  .stat.hot .rate {
    color: var(--accent);
  }
  .stat .rate {
    font-weight: 700;
  }

  .msg-actions {
    display: flex;
    gap: 4px;
    margin-top: 6px;
    opacity: 0;
    transition: opacity var(--dur-fast) ease;
  }
  .msg-actions.show {
    opacity: 1;
  }
  .msg-action-btn {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    display: grid;
    place-items: center;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    color: var(--text-dim);
    font-size: 12px;
    cursor: pointer;
    transition: all var(--dur-fast) ease;
  }
  .copy-btn:hover {
    color: var(--info);
    border-color: rgba(96, 165, 250, 0.3);
    background: rgba(96, 165, 250, 0.08);
  }

  /* ── 长按 / 右键菜单浮层 ──
     fixed 定位（坐标由 JS 按消息 rect 计算），故不会被 .messages 的
     overflow:auto 裁剪。玻璃底 + 小气泡观感，复用 token。 */
  .msg-menu {
    position: fixed;
    z-index: var(--z-modal);
    min-width: 168px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: var(--radius-lg);
    animation: menuIn var(--dur-fast) var(--ease-standard);
  }
  /* 用户消息：右对齐（菜单左边贴消息右缘）；助手消息：左对齐 */
  .msg-menu.menu-user {
    transform: translateX(-100%);
  }
  /* 仅动画透明度：若动画 transform 会覆盖 .menu-user 的 translateX 造成跳位 */
  @keyframes menuIn {
    from {
      opacity: 0;
    }
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    width: 100%;
    padding: 9px 12px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .menu-item:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .menu-item.danger:hover {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }
  .menu-ico {
    width: 16px;
    text-align: center;
    font-size: 0.9rem;
    opacity: 0.85;
  }

  /* ── 附图缩略图 ── */
  .msg-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .msg-image-btn {
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    overflow: hidden;
    line-height: 0;
  }
  .msg-image-btn img {
    display: block;
    max-width: 160px;
    max-height: 160px;
    object-fit: cover;
  }

  /* ── 大图预览：整屏遮罩，点击任意处关闭 ── */
  .msg-zoom {
    position: fixed;
    inset: 0;
    z-index: var(--z-overlay, 100);
    display: grid;
    place-items: center;
    padding: 24px;
    border: none;
    background: rgba(0, 0, 0, 0.78);
    cursor: zoom-out;
  }
  .msg-zoom img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
