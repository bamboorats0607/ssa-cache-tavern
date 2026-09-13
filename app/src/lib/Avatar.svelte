<script lang="ts">
  /**
   * 头像。有图片地址则渲染图片，加载失败或未提供时回退首字母。
   *
   * 为什么需要这个组件：
   *   顶栏、消息气泡、角色列表三处都需要「有图显示图、没图显示首字母」，
   *   且都必须能在图片 404 时回退（后端尚未就绪、角色无头像文件等）。
   *   三处逻辑完全一致，抽出来避免各自实现导致行为漂移。
   *
   * 图片 URL 必须由 backend.ts 的 characterAvatarUrl() 等函数生成（绝对 URL）——
   * 页面 origin 是 https://localhost，根相对路径命中不了 127.0.0.1:4444 的后端。
   *
   * 尺寸用 `size` 内联注入，而**不是**由父组件传 class：
   *   组件内的元素带 Svelte 作用域哈希，父组件的 `.avatar{width:38px}` 选不中它，
   *   尺寸会静默失效。内联宽高不受作用域影响，最稳。
   */
  interface Props {
    /** 已解析好的绝对图片 URL；null / undefined 时直接回退首字母 */
    src?: string | null;
    /** 回退用的文字（取首字母大写） */
    name?: string;
    /** 完全无名字时的兜底字符 */
    fallbackChar?: string;
    /** 无障碍标签；缺省用 name */
    alt?: string;
    /** 边长（px） */
    size?: number;
  }
  let { src, name, fallbackChar = '?', alt, size = 38 }: Props = $props();

  /** 图片加载失败（404 / 混合内容被拒 / 后端未就绪）→ 回退首字母 */
  let failed = $state(false);

  // src 变化时重置失败标记，否则换角色后仍显示旧的首字母
  $effect(() => {
    void src;
    failed = false;
  });

  const initial = $derived((name?.trim()?.[0] ?? fallbackChar).toUpperCase());
  const showImage = $derived(Boolean(src) && !failed);
  /** 宽高与首字母字号都由 size 派生，避免父组件作用域样式选不中 */
  const box = $derived(`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px`);
</script>

{#if showImage}
  <img
    class="avatar-img"
    style={box}
    src={src}
    alt={alt ?? name ?? '头像'}
    loading="lazy"
    onerror={() => (failed = true)}
  />
{:else}
  <span class="avatar-fallback" style={box} aria-hidden="true">{initial}</span>
{/if}

<style>
  .avatar-img {
    object-fit: cover;
    object-position: center top;
    flex-shrink: 0;
    display: block;
    border-radius: var(--radius-lg);
    background: var(--surface-2, transparent);
  }
  .avatar-fallback {
    display: grid;
    place-items: center;
    border-radius: var(--radius-lg);
    background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
    color: var(--on-accent);
    font-weight: 800;
    flex-shrink: 0;
  }
</style>
