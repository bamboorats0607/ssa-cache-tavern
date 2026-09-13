<script lang="ts">
  /**
   * 调试面板：技术细节的唯一出口。
   *
   * 设计：默认不可见。只有连续点击版本号 7 次（或 ?debug=1）才解锁。
   * 解锁后展示日志、后端地址、上下文机制状态。
   */
  import { onMount } from 'svelte';
  import {
    logger,
    isDebugEnabled,
    setDebugEnabled,
    getLogs,
    clearLogs,
    exportLogs,
    subscribeLogs,
    type LogEntry,
  } from '../lib/logger';
  import { getBaseUrl, setBaseUrl, probeBackend } from '../lib/backend';

  let entries = $state<readonly LogEntry[]>([]);
  let backendUrl = $state(getBaseUrl());
  let filter = $state<'all' | 'error' | 'warn' | 'info' | 'debug'>('all');
  let probing = $state(false);

  const filtered = $derived(
    filter === 'all' ? entries : entries.filter((e) => e.level === filter),
  );

  onMount(() => {
    entries = getLogs();
    return subscribeLogs((next) => (entries = [...next]));
  });

  function toggle() {
    setDebugEnabled(!isDebugEnabled());
  }

  async function recheck() {
    probing = true;
    const r = await probeBackend(backendUrl, { retries: 2, intervalMs: 500 });
    logger.info('debug', '手动探测完成', r.state);
    probing = false;
  }

  function applyUrl() {
    setBaseUrl(backendUrl);
  }

  function copyLogs() {
    navigator.clipboard?.writeText(exportLogs()).catch(() => {});
  }

  function fmtTime(ts: number) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
</script>

<div class="debug">
  <section class="panel glass">
    <div class="row">
      <div>
        <h3>调试模式</h3>
        <p class="hint">开启后记录完整日志，并在浏览器控制台输出。</p>
      </div>
      <button class="switch" class:on={isDebugEnabled()} onclick={toggle} aria-label="切换调试模式">
        <span class="knob"></span>
      </button>
    </div>
  </section>

  <section class="panel glass">
    <h3>后端地址</h3>
    <div class="row">
      <input class="input" bind:value={backendUrl} placeholder="http://..." />
      <button class="btn" onclick={applyUrl}>保存</button>
      <button class="btn btn-accent" onclick={recheck} disabled={probing}>
        {probing ? '探测中…' : '探测'}
      </button>
    </div>
  </section>

  <section class="panel glass logs-panel">
    <div class="row">
      <h3>日志（{filtered.length}）</h3>
      <div class="actions">
        <button class="btn" onclick={copyLogs}>复制</button>
        <button class="btn" onclick={clearLogs}>清空</button>
      </div>
    </div>
    <div class="filters">
      {#each ['all', 'error', 'warn', 'info', 'debug'] as f (f)}
        <button class="fchip" class:active={filter === f} onclick={() => (filter = f as typeof filter)}>
          {f}
        </button>
      {/each}
    </div>
    <div class="logs">
      {#if filtered.length === 0}
        <p class="hint">暂无日志</p>
      {:else}
        {#each filtered.slice(-200).reverse() as e (e.ts + e.message)}
          <div class="log-line lv-{e.level}">
            <span class="t">{fmtTime(e.ts)}</span>
            <span class="lv">{e.level}</span>
            <span class="sc">{e.scope}</span>
            <span class="msg">{e.message}</span>
          </div>
        {/each}
      {/if}
    </div>
  </section>
</div>

<style>
  .debug {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    min-height: 0;
  }
  .panel {
    border-radius: var(--radius-2xl);
    padding: var(--gap-lg);
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
  }
  .logs-panel {
    flex: 1;
    min-height: 0;
  }
  h3 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 700;
  }
  .hint {
    margin: 0;
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .row > div:first-child {
    flex: 1;
    min-width: 160px;
  }
  .actions {
    display: flex;
    gap: var(--gap-xs);
  }

  .switch {
    width: 44px;
    height: 26px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    position: relative;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-standard);
    flex-shrink: 0;
  }
  .switch.on {
    background: var(--accent-soft);
    border-color: var(--accent-border);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text-dim);
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .switch.on .knob {
    left: 20px;
    background: var(--accent);
  }

  .filters {
    display: flex;
    gap: var(--gap-xs);
    flex-wrap: wrap;
  }
  .fchip {
    padding: 3px 10px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--glass-border);
    background: var(--neutral-1);
    color: var(--text-dim);
    font-size: 0.68rem;
    font-family: inherit;
    cursor: pointer;
  }
  .fchip.active {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    color: var(--accent);
  }

  .logs {
    flex: 1;
    overflow-y: auto;
    min-height: 120px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    line-height: 1.5;
  }
  .log-line {
    display: flex;
    gap: var(--gap-sm);
    padding: 2px 0;
    border-bottom: 1px solid var(--neutral-1);
  }
  .t {
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .lv {
    flex-shrink: 0;
    width: 40px;
    text-transform: uppercase;
  }
  .sc {
    color: var(--text-dim);
    flex-shrink: 0;
    width: 60px;
  }
  .msg {
    color: var(--text-muted);
    word-break: break-word;
  }
  .lv-error .lv {
    color: var(--danger);
  }
  .lv-warn .lv {
    color: var(--accent);
  }
  .lv-info .lv {
    color: var(--info);
  }
  .lv-debug .lv {
    color: var(--text-faint);
  }
</style>
