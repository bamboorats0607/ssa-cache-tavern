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
   * 角色图由 `.art` 承载，图片地址由 App.svelte 作为 `art` prop 传入
   * （默认取当前角色头像全图；未传时 `.art` 不渲染任何东西）。
   * 玻璃拟态仍然成立：模糊的对象是这层渐变 + 柔光 + 角色图，而不是花哨的动态纹理。
   */
  import { theme } from '../stores/theme.svelte';

  interface Props {
    /** 角色立绘的**绝对** URL（已由 characterAvatarUrl() 解析）；null 则不渲染 */
    art?: string | null;
    /**
     * 媒体类型，对齐上游 backgrounds 契约的 `mediaType: 'video' | 'image'`。
     * 本次只消费 'image'；传 'video' 时留空（视频播放逻辑本次不实现）。
     */
    type?: 'image' | 'video';
  }
  let { art, type = 'image' }: Props = $props();

  // 依赖 theme.current 触发重渲染，保证换主题时背景即时联动
  const themeId = $derived(theme.current);
</script>

<div class="bg" data-bg-theme={themeId} aria-hidden="true">
  <div class="depth"></div>
  <div class="glow"></div>
  <!-- 角色立绘位：图片走 CSS 变量注入；未传地址或为视频时该层不渲染（视频背景待后续实现） -->
  {#if art && type === 'image'}
    <div class="art" style="--bg-art: url('{art}')"></div>
    <!-- 压暗罩：立绘是照片级画面，不压暗则正文与玻璃面板上的文字读不清。
         只用一层纯色半透明，不加纹理、不加 blur，符合「背景极简」约束。 -->
    <div class="art-veil"></div>
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

  /* 角色立绘位。地址由内联 --bg-art 注入；未注入时解析为 none，整层不可见。
     锚点必须是 top 而非 bottom/center：
     - 素材是 2:3 竖版整幅插画，cover 在竖屏下会纵向溢出约 5.14%；
       锚 bottom 会把溢出全部压到顶部 → 裁掉人物头部；
       锚 center 则上下各裁 2.57% → 头脚双切；
       锚 top 让溢出全部落在底部 → 头部完整保留。 */
  .art {
    position: absolute;
    inset: 0;
    background-image: var(--bg-art, none);
    background-size: cover;
    background-position: center top;
    background-repeat: no-repeat;
  }

  /* 横屏族：竖版素材在横版视口下用 cover 必然裁掉 53%，改用 contain 保全身。
     锚 right center 让立绘靠右下，为左侧气泡列留出空间（气泡让位见 tokens.css / ChatView.svelte）。
     注意：contain 会产生左右留白 —— 立绘是不透明整幅插画（非透明抠图），
     因项目禁用 filter: blur()，硬边无法软化，只能靠既有 .art-veil 压暗缓解。 */
  @media (min-aspect-ratio: 1/1) {
    .art {
      background-size: contain;
      background-position: right center;
    }
  }

  /* 压暗罩：把立绘压到「可辨但不抢戏」，保证正文对比度。
     两层自上而下由浅到深，让底部输入区更实、上方仍能看见立绘。 */
  .art-veil {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--bg-root) 72%, transparent) 0%,
      color-mix(in srgb, var(--bg-root) 62%, transparent) 52%,
      color-mix(in srgb, var(--bg-root) 80%, transparent) 100%
    );
  }
</style>
