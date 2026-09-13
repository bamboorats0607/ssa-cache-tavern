<script lang="ts">
  /** 占位视图：未接入的导航页。 */
  interface Props {
    title: string;
    hint?: string;
  }
  let { title, hint = '' }: Props = $props();
</script>

<div class="empty-view glass animate-fade-in">
  <h2>{title}</h2>
  {#if hint}<p>{hint}</p>{/if}
</div>

<style>
  .empty-view {
    flex: 1;
    border-radius: var(--radius-2xl);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--gap-sm);
    padding: var(--gap-2xl);
    text-align: center;
  }
  h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  p {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
</style>
