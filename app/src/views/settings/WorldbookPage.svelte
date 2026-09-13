<script lang="ts">
  /**
   * 世界书设置页。
   *
   * 字段对齐 `world_info_*`（world-info.js:108-125），默认值取源码默认。
   *
   * 本页只负责**全局行为开关**（扫描/预算/匹配）与「激活哪一本」。
   * 世界书的增删改查（新建 / 条目编辑 / 删除 / 重命名）在顶栏「世界书」tab
   * 的 `views/WorldbookView.svelte` 中；两处共用 worldbook store，状态一致。
   * 下面的「激活的世界书」分组内提供新建入口，方便就近操作。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import { advanced, WI_STRATEGIES } from '../../stores/advanced.svelte';
  import { ctxConfig } from '../../stores/context.svelte';
  import { worldbook } from '../../stores/worldbook.svelte';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  // 列表在进入本页时拉取（首次由聊天页加载过则直接命中）
  worldbook.load();

  // 就近新建：名字在校验通过后写入并立即激活（详细条目编辑在顶栏世界书页）
  let newBookName = $state('');

  async function createBook() {
    const ok = await worldbook.create(newBookName);
    if (ok) {
      await worldbook.select(newBookName.trim());
      newBookName = '';
    }
  }

  const wiBudget = $derived(advanced.get('wiBudget'));
  const budgetLabel = $derived(
    wiBudget > 100 ? '超限，已回退为 25%' : `占上下文 ${wiBudget}%`,
  );
</script>

<SubPage title="世界书" {onBack}>
  <!-- 激活哪一本：这是世界书真正生效的入口。
       未选择时上下文只剩角色设定（不报错，静默降级）。 -->
  <SettingGroup title="激活的世界书">
    {#if worldbook.list.length === 0}
      <SettingRow label="未找到世界书" desc="后端未提供世界书，或列表接口不可用" />
    {:else}
      <SettingRow
        label="不启用"
        desc="只使用角色设定，不注入任何世界书条目"
        value={worldbook.activeName === null ? '✓ 当前' : undefined}
        onclick={() => worldbook.select(null)}
      />
      {#each worldbook.list as w (w.fileId)}
        <SettingRow
          label={w.name}
          desc={worldbook.activeName === w.name
            ? `已激活 · 载入 ${worldbook.entries.length} 条`
            : undefined}
          value={worldbook.activeName === w.name ? '✓ 当前' : undefined}
          onclick={() => worldbook.select(w.name)}
        />
      {/each}
    {/if}

    <!-- 就近新建：标签在上、输入与按钮在下（窄屏不挤压）。
         条目级的增删改在顶栏「世界书」页完成。 -->
    <SettingRow label="新建世界书" desc="创建后立即激活" stacked>
      {#snippet trailing()}
        <input
          class="input"
          type="text"
          placeholder="世界书名称"
          bind:value={newBookName}
        />
        <button class="btn btn-accent" onclick={createBook} disabled={worldbook.writing}>
          {worldbook.writing ? '创建中…' : '创建'}
        </button>
      {/snippet}
    </SettingRow>

    {#if worldbook.lastWriteError}
      <SettingRow label="操作失败" value={worldbook.lastWriteError} />
    {/if}
    {#if worldbook.lastError}
      <SettingRow label="加载失败" value={worldbook.lastError} />
    {/if}
  </SettingGroup>

  <SettingGroup title="扫描">
    <SettingRow label="扫描深度" desc="回看多少条消息做关键词匹配">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          max={1000}
          value={advanced.get('wiDepth')}
          unit="条"
          onchange={(v) => advanced.set('wiDepth', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="最少激活条目" desc="0 = 不强制激活">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          max={100}
          value={advanced.get('wiMinActivations')}
          onchange={(v) => advanced.set('wiMinActivations', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="最大递归步数" desc="0 = 不限制">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          max={10}
          value={advanced.get('wiMaxRecursionSteps')}
          onchange={(v) => advanced.set('wiMaxRecursionSteps', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow
      label="递归扫描"
      desc="激活的条目内容可再触发其它条目"
      kind="toggle"
      checked={advanced.get('wiRecursive')}
      onchange={(v) => advanced.set('wiRecursive', v)}
    />
  </SettingGroup>

  <SettingGroup title="预算">
    <SettingRow label="预算占比" desc={budgetLabel}>
      {#snippet trailing()}
        <Field
          kind="number"
          min={1}
          max={100}
          value={wiBudget}
          unit="%"
          onchange={(v) => advanced.set('wiBudget', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="预算硬顶" desc="0 = 不限制">
      {#snippet trailing()}
        <Field
          kind="number"
          min={0}
          max={65536}
          value={advanced.get('wiBudgetCap')}
          unit="token"
          onchange={(v) => advanced.set('wiBudgetCap', Number(v))}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="插入策略">
      {#snippet trailing()}
        <Field
          kind="select"
          value={advanced.get('wiCharacterStrategy')}
          options={WI_STRATEGIES}
          onchange={(v) => advanced.set('wiCharacterStrategy', Number(v))}
        />
      {/snippet}
    </SettingRow>
  </SettingGroup>

  <SettingGroup title="匹配">
    <SettingRow
      label="区分大小写"
      kind="toggle"
      checked={advanced.get('wiCaseSensitive')}
      onchange={(v) => advanced.set('wiCaseSensitive', v)}
    />
    <SettingRow
      label="全词匹配"
      desc="避免子串误命中"
      kind="toggle"
      checked={advanced.get('wiMatchWholeWords')}
      onchange={(v) => advanced.set('wiMatchWholeWords', v)}
    />
    <SettingRow
      label="扫描包含角色名"
      kind="toggle"
      checked={advanced.get('wiIncludeNames')}
      onchange={(v) => advanced.set('wiIncludeNames', v)}
    />
    <SettingRow
      label="分组评分"
      desc="同组条目按组取最优"
      kind="toggle"
      checked={advanced.get('wiUseGroupScoring')}
      onchange={(v) => advanced.set('wiUseGroupScoring', v)}
    />
  </SettingGroup>

  <SettingGroup title="与上下文的配合">
    <SettingRow
      label="自动转换活簇"
      desc="导入的社区世界书自动分层，配合双层策略"
      kind="toggle"
      checked={ctxConfig.liveClusterWorldbook}
      onchange={(v) => {
        ctxConfig.set('liveClusterWorldbook', v);
        if (v) ctxConfig.setStrategy('sl');
      }}
    />
  </SettingGroup>
</SubPage>
