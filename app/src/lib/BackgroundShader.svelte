<script lang="ts">
  /**
   * 背景层：极简。
   *
   * ── 演进史（约束来源，勿删）──────────────────────────────────────────────
   * 1. WebGL 流动噪声：所有主题都渲染成同一片深蓝紫 → 换主题看不出变化；且是均匀色，
   *    玻璃面板压上去没有可模糊的层次。
   * 2. 3 个圆形色斑：分布僵硬，屏幕上就是角落两坨、中间空场。
   * 3. 柔光粒子 / 水光带 / 波浪 canvas：反复迭代仍不稳定，且**抢了主角**——
   *    背景本来是要放**角色图**的（用户原话「背景本来是要放角色图的，还是极简吧」）。
   *    任何自带复杂纹理的背景都会与角色立绘打架，这里彻底收敛。
   *
   * ── 本代设计：把舞台让出来 ───────────────────────────────────────────────
   * 只保留两样东西：
   *   · 一层极浅的主题色纵向渐变（提供空间纵深，不留死白）
   *   · 一层顶部柔光（给玻璃面板一点可模糊的明暗过渡）
   * 媒体由 `.art` 承载，地址由 App.svelte 作为 `art` prop 传入
   * （默认取当前角色头像全图；用户可改为自定义图片/短视频；未传时不渲染）。
   * 玻璃拟态仍然成立：模糊的对象是这层渐变 + 柔光 + 角色图，而不是花哨的动态纹理。
   *
   * ── 压暗罩为什么是「中性色」（勿改回主题色）─────────────────────────────
   * 旧实现用 `color-mix(--bg-root …)` 叠在媒体之上。--bg-root 是**主题基色**
   * （如沧溟=奶油色 #faf2e0），于是切换主题时整张背景跟着变色调、发白，
   * 用户看到的是「背景被主题颜色糊住、像压在图层最底层」。
   * 现改为**中性黑**，与主题彻底解耦：任何主题下媒体本色都不被染色，
   * 只按 `dim` 调节明暗，保证正文对比度。
   */
  import { theme } from '../stores/theme.svelte';

  interface Props {
    /** 媒体**绝对** URL（已由 characterAvatarUrl() / characterBackgroundUrl() 解析）；null 则不渲染 */
    art?: string | null;
    /** 媒体类型：图片走 <img>，视频走静音循环自动播放 */
    type?: 'image' | 'video';
    /**
     * 锚定策略：
     *  · 'auto'  —— 默认头像（2:3 竖版）：竖屏 cover，横屏改 contain 靠右，
     *               为左侧气泡列让位（与 tokens.css 的 --art-w 假设配套）。
     *  · 'cover' —— 用户自定义媒体：整幅铺满（横屏也不让位），
     *               此时 App 会把 --art-w 归零、气泡恢复满宽。
     */
    fit?: 'auto' | 'cover';
    /** 压暗罩强度 0–100（0 = 不压暗，100 = 最暗）；中性黑，不影响色相 */
    dim?: number;
    /** 媒体加载失败回调（App 据此回落到头像） */
    onerror?: () => void;
  }
  let { art, type = 'image', fit = 'auto', dim = 42, onerror }: Props = $props();

  // 依赖 theme.current 触发重渲染，保证换主题时背景即时联动
  const themeId = $derived(theme.current);

  /** 压暗罩三段不透明度：底部更实（输入区），上方略浅（仍能看见媒体）。 */
  const veil = $derived.by(() => {
    const d = Math.min(100, Math.max(0, dim)) / 100;
    return {
      top: `${Math.round(d * 82)}%`,
      mid: `${Math.round(d * 100)}%`,
      bottom: `${Math.min(100, Math.round(d * 118))}%`,
    };
  });
</script>

<div class="bg" data-bg-theme={themeId} data-fit={fit} aria-hidden="true">
  <div class="depth"></div>
  <div class="glow"></div>
  <!-- 媒体位：图片 / 视频二选一；未传地址时不渲染任何媒体层 -->
  {#if art && type === 'video'}
    <video
      class="art"
      src={art}
      muted
      autoplay
      loop
      playsinline
      disablepictureinpicture
      onerror={onerror}
    ></video>
  {:else if art}
    <img class="art" src={art} alt="" draggable="false" onerror={onerror} />
  {/if}
  {#if art}
    <!-- 压暗罩：媒体是照片级画面，不压暗则正文与玻璃面板上的文字读不清。
         中性黑 + 可调强度（dim），不加纹理、不加 blur，符合「背景极简」约束。 -->
    <div
      class="art-veil"
      style="--veil-top: {veil.top}; --veil-mid: {veil.mid}; --veil-bottom: {veil.bottom}"
    ></div>
  {/if}
</div>

<style>
  /* 背景层高度必须锚定到「不随软键盘变化」的稳定视口单位：
     - 用 vh 而非 dvh：dvh 会随浏览器 UI / 软键盘的收放实时变化，
       一旦高度变了，.art 的 cover/contain 就会重算缩放比例 → 立绘肉眼可见地跳动；
       lvh（large viewport height）取「浏览器 UI 收起时」的最大视口高，软键盘弹出时保持恒定，
       故 scale 恒定、立绘稳定。
     - fixed 定位下用 top/left + width/height 等价替代原来的 inset: 0。 */
  .bg {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100vh;
    z-index: var(--z-bg);
    pointer-events: none;
    overflow: hidden;
    background: var(--bg-root);
  }

  /* 支持 lvh 的浏览器升级为 100lvh（不随软键盘变化）；不支持的回落上面的 100vh。 */
  @supports (height: 100lvh) {
    .bg {
      height: 100lvh;
    }
  }

  /* 极浅的主题色纵深：上端天光、下端略沉。仅此一层，不参与动画。 */
  .depth {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--bg-root) 88%, var(--bg-blob-3)) 0%,
      var(--bg-root) 38%,
      color-mix(in srgb, var(--bg-root) 86%, var(--bg-blob-1)) 100%
    );
  }

  /* 顶部柔光：给顶栏/玻璃面板一点可模糊的明暗过渡。
     柔边由 radial-gradient 的多段透明过渡直接画出，不使用 filter: blur()。 */
  .glow {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      120% 46% at 50% -12%,
      color-mix(in srgb, var(--bg-blob-3) 60%, transparent) 0%,
      transparent 68%
    );
  }

  /* 媒体位（<img> 与 <video> 共用）。锚点必须是 top 而非 bottom/center：
     - 素材是 2:3 竖版整幅插画，cover 在竖屏下会纵向溢出约 5.14%；
       锚 bottom 会把溢出全部压到顶部 → 裁掉人物头部；
       锚 center 则上下各裁 2.57% → 头脚双切；
       锚 top 让溢出全部落在底部 → 头部完整保留。 */
  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
  }

  /* 横屏族·默认头像：竖版素材在横版视口下用 cover 必然裁掉 53%，改用 contain 保全身。
     锚 right center 让立绘靠右下，为左侧气泡列留出空间（气泡让位见 tokens.css / ChatView.svelte）。
     注意：contain 会产生左右留白 —— 立绘是不透明整幅插画（非透明抠图），
     因项目禁用 filter: blur()，硬边无法软化，只能靠既有 .art-veil 压暗缓解。 */
  @media (min-aspect-ratio: 1/1) {
    .bg[data-fit='auto'] .art {
      object-fit: contain;
      object-position: right center;
    }
  }

  /* 自定义媒体（fit=cover）：任何朝向都整幅铺满，居中锚定、不参与让位。 */
  .bg[data-fit='cover'] .art {
    object-fit: cover;
    object-position: center;
  }

  /* 压暗罩：把媒体压到「可辨但不抢戏」，保证正文对比度。
     三段自上而下由浅到深，让底部输入区更实、上方仍能看见媒体。
     纯中性黑，不引用任何主题变量 —— 从根上切断「主题改色 → 背景跟着变」。 */
  .art-veil {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to bottom,
      rgb(0 0 0 / var(--veil-top, 34%)) 0%,
      rgb(0 0 0 / var(--veil-mid, 42%)) 52%,
      rgb(0 0 0 / var(--veil-bottom, 50%)) 100%
    );
  }
</style>
