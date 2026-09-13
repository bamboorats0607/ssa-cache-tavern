<script lang="ts">
  /**
   * 占位子页：功能尚未接入时给出诚实的说明，而不是空白页。
   *
   * 产品原则：宁可告诉用户「还没做」，也不放一个假的可点入口。
   */
  import SubPage from './SubPage.svelte';

  interface Props {
    title: string;
    desc: string;
    onBack: () => void;
  }
  let { title, desc, onBack }: Props = $props();
</script>

<SubPage {title} {onBack}>
  <div class="empty">
    <div class="mark">·</div>
    <p>{desc}</p>
    <p class="hint">此模块将在后续版本接入。</p>
  </div>
</SubPage>

<style>
  .empty {
    margin: auto;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-2xl) var(--gap-lg);
    max-width: 360px;
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
  .empty p {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .empty .hint {
    font-size: 0.74rem;
    color: var(--text-dim);
  }
</style>
