<script lang="ts">
  /**
   * Tavern 应用外壳：四层导航 + 主内容区。
   *
   * 布局：手机 = 底部标签栏；桌面（≥900px）= 左侧边栏。
   * 调试入口：在设置页连续点击底部版本号 7 次解锁（面向开发者，不干扰普通用户）。
   */
  import BackgroundShader from './lib/BackgroundShader.svelte';
  import ChatView from './views/ChatView.svelte';
  import CharactersView from './views/CharactersView.svelte';
  import WorldbookView from './views/WorldbookView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import DebugView from './views/DebugView.svelte';
  import EmptyView from './views/EmptyView.svelte';
  import { isDebugEnabled, logger } from './lib/logger';
  import { pushBack } from './lib/back';
  import { characters } from './stores/characters.svelte';
  import { background } from './stores/background.svelte';
  import { characterAvatarUrl, characterBackgroundUrl } from './lib/backend';

  type Tab = 'chat' | 'characters' | 'worldbook' | 'settings' | 'debug';

  interface NavItem {
    id: Tab;
    label: string;
    icon: string;
  }

  const NAV: NavItem[] = [
    { id: 'chat', label: '聊天', icon: 'M4 4h16v12H7l-3 3V4z' },
    {
      id: 'characters',
      label: '角色',
      icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z',
    },
    { id: 'worldbook', label: '世界书', icon: 'M4 4h7v16H4V4zm9 0h7v16h-7V4z' },
    {
      id: 'settings',
      label: '设置',
      // 线性 stroke 齿轮：外圈 + 轮毂 + 8 根短径向齿，不依赖 fill
      // （原路径是 Material 实心填充字形，被 1.8px 细线描边后糊成一团）
      icon: 'M5.8 12a6.2 6.2 0 1 1 12.4 0a6.2 6.2 0 1 1-12.4 0M12 9.4a2.6 2.6 0 1 1 0 5.2a2.6 2.6 0 1 1 0-5.2M18.2 12h3M12 18.2v3M5.8 12h-3M12 5.8v-3M16.384 16.384l2.121 2.121M7.616 16.384l-2.121 2.121M7.616 7.616L5.495 5.495M16.384 7.616l2.121-2.121',
    },
  ];

  let active: Tab = $state('chat');
  let debugVisible = $state(isDebugEnabled());

  // 7 连击解锁（防误触：窗口 3 秒）
  let tapCount = 0;
  let tapTimer: number | null = null;

  function onSecretTap() {
    tapCount++;
    if (tapTimer) window.clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => (tapCount = 0), 3000);
    if (tapCount >= 7) {
      tapCount = 0;
      debugVisible = true;
      // 同步 logger 的 debug 开关由 DebugView 内部控制；此处仅暴露入口
    }
  }

  const ALL_NAV = $derived(
    debugVisible ? [...NAV, { id: 'debug' as Tab, label: '调试', icon: 'M12 2l3 6h6l-5 4 2 7-6-4-6 4 2-7-5-4h6z' }] : NAV,
  );

  /**
   * 末级返回处理（优先级 10，最后执行）。
   *
   * 非聊天标签页 → 回到聊天页并消费本次返回；已在聊天页 → 返回 false，
   * 交给原生处理（原生 moveTaskToBack，退到后台而不是杀进程）。
   * 回调延迟执行，读取的是最新的 active 值。
   */
  $effect(() => {
    const off = pushBack(() => {
      if (active !== 'chat') {
        active = 'chat';
        return true;
      }
      return false;
    }, 10);
    return off;
  });

  /**
   * 背景：默认取当前角色的头像全图铺开（用户原话「头像全图默认作为背景」）；
   * 用户可在「外观」页改为自定义图片 / 短视频（见 background store）。
   *
   * 解析顺序（每层都可能为空）：
   *   自定义媒体（未被判定失败）→ 角色头像 → 不渲染
   * 自定义媒体**加载失败**时回落到头像（用户明确要求）；失败标记是瞬时的，
   * 切换媒体 / 角色后自动复位，不改动用户设置。
   */
  const avatarArtUrl = $derived(characterAvatarUrl(characters.fallback?.avatar));
  const customArtUrl = $derived(
    background.state.mode === 'custom' && background.state.file
      ? characterBackgroundUrl(background.state.file)
      : null,
  );

  let customFailed = $state(false);
  let avatarFailed = $state(false);

  // 更换自定义媒体 / 角色头像时复位失败标记（仅读对应 URL，不读失败标记本身，无回环）
  $effect(() => {
    void customArtUrl;
    customFailed = false;
    background.markDegraded(false);
  });
  $effect(() => {
    void avatarArtUrl;
    avatarFailed = false;
  });

  const usingCustom = $derived(!!customArtUrl && !customFailed);
  const bgArtUrl = $derived(usingCustom ? customArtUrl : avatarFailed ? null : avatarArtUrl);
  // 自定义媒体类型对齐上游 backgrounds 契约的 `mediaType: 'video' | 'image'`；默认头像恒为图片
  const bgType = $derived(usingCustom ? background.state.mediaType : ('image' as const));
  // 自定义媒体整幅铺满（气泡不让位）；默认头像沿用 2:3 让位策略
  const bgFit = $derived<'auto' | 'cover'>(usingCustom ? 'cover' : 'auto');

  function onBgMediaError() {
    if (usingCustom) {
      customFailed = true;
      background.markDegraded(true);
      logger.warn('background', '自定义背景加载失败，已回落到角色头像');
    } else {
      avatarFailed = true;
    }
  }
</script>

<!-- 背景层：极简渐变 + 媒体位（角色头像 / 自定义图片 / 自定义短视频） -->
<BackgroundShader
  art={bgArtUrl}
  type={bgType}
  fit={bgFit}
  dim={background.state.dim}
  onerror={onBgMediaError}
/>

<div class="shell" class:bg-cover={usingCustom}>
  <div class="app-body">
    <!-- 左侧栏（桌面） -->
    <nav class="sidebar glass" aria-label="主导航">
      <div class="brand">
        <span class="brand-mark">T</span>
        <span class="brand-name">Tavern</span>
      </div>
      <ul class="nav-list">
        {#each ALL_NAV as item (item.id)}
          <li>
            <button
              class="nav-item"
              class:active={active === item.id}
              onclick={() => (active = item.id)}
              aria-current={active === item.id ? 'page' : undefined}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={item.icon} />
              </svg>
              <span>{item.label}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>

    <!-- 主内容 -->
    <main class="content">
      {#if active === 'chat'}
        <ChatView onOpenCharacters={() => (active = 'characters')} />
      {:else if active === 'characters'}
        <CharactersView onOpenChat={() => (active = 'chat')} />
      {:else if active === 'worldbook'}
        <WorldbookView />
      {:else if active === 'settings'}
        <SettingsView />
      {:else if active === 'debug'}
        <DebugView />
      {:else}
        <EmptyView
          title={NAV.find((n) => n.id === active)?.label ?? ''}
          hint="此模块将在后续版本接入"
        />
      {/if}
    </main>
  </div>

  <!-- 底部标签栏（移动） -->
  <nav class="tabbar glass" aria-label="主导航">
    {#each ALL_NAV as item (item.id)}
      <button
        class="tab-item"
        class:active={active === item.id}
        onclick={() => (active = item.id)}
        aria-current={active === item.id ? 'page' : undefined}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={item.icon} />
        </svg>
        <span>{item.label}</span>
      </button>
    {/each}
  </nav>

  <!-- 隐藏解锁热区：左下角小透明区域，7 连击生效 -->
  <button class="secret-tap" onclick={onSecretTap} aria-label="版本信息" title=""></button>
</div>

<style>
  .shell {
    position: relative;
    height: var(--app-height);
    display: flex;
    flex-direction: column;
    z-index: var(--z-content);
  }

  /* 自定义背景整幅铺满 → 气泡无需再给立绘让位。
     横屏的 max-width 是「减 --art-w」（见 ChatView.svelte），故这里必须归零才是满宽。 */
  .shell.bg-cover {
    --art-w: 0px;
  }

  .secret-tap {
    position: fixed;
    left: 0;
    bottom: 0;
    width: 44px;
    height: 44px;
    background: transparent;
    border: none;
    cursor: default;
    z-index: var(--z-nav);
    opacity: 0;
  }

  .app-body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .sidebar {
    display: none;
    flex-direction: column;
    width: 84px;
    margin: var(--gap-md) 0 var(--gap-md) var(--gap-md);
    border-radius: var(--radius-2xl);
    padding: var(--gap-lg) var(--gap-sm);
    gap: var(--gap-xl);
    flex-shrink: 0;
  }

  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);
  }
  .brand-mark {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
    color: var(--on-accent);
    font-weight: 800;
    font-size: 1.1rem;
    box-shadow: 0 4px 16px var(--accent-glow);
  }
  .brand-name {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .nav-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
  }
  .nav-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: var(--gap-md) 4px;
    border: none;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.65rem;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .nav-item svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .nav-item:hover {
    background: var(--neutral-1);
    color: var(--text-muted);
  }
  .nav-item.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: var(--gap-md);
    /* 顶部让出状态栏安全区（Android 15+ 强制 edge-to-edge，内容会绘制到状态栏下）；
       桌面分支不覆盖 padding-top，env() 返回 0 即自然失效 */
    padding-top: calc(var(--gap-md) + var(--safe-top));
    padding-bottom: calc(92px + var(--safe-bottom));
  }

  .tabbar {
    position: fixed;
    left: var(--gap-md);
    right: var(--gap-md);
    bottom: calc(var(--gap-md) + var(--safe-bottom));
    border-radius: var(--radius-2xl);
    display: flex;
    justify-content: space-around;
    padding: 6px;
    z-index: var(--z-nav);
    box-sizing: border-box;
    overflow: hidden;
  }
  .tab-item {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 8px 4px;
    border: none;
    border-radius: var(--radius-xl);
    background: transparent;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.65rem;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease-standard);
    -webkit-tap-highlight-color: transparent;
  }
  .tab-item span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-item svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .tab-item.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .tab-item:active {
    transform: scale(0.95);
  }

  @media (min-width: 900px) {
    .sidebar {
      display: flex;
    }
    .tabbar {
      display: none;
    }
    .content {
      padding-bottom: var(--gap-md);
    }
  }
</style>
