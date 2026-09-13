<script lang="ts">
  /**
   * 设置主页（Tavo 式列表导航）。
   *
   * 分组与 Tavo 对齐：连接 / 模型 / 上下文与记忆 / 角色与身份 / 外观 /
   * 聊天 / 数据 / 帮助。每行右侧显示当前值，一眼可见状态。
   */
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import { theme, THEMES } from '../../stores/theme.svelte';
  import { ctxConfig, memoryConfig } from '../../stores/context.svelte';
  import { modelConfig } from '../../stores/model.svelte';
  import { advanced } from '../../stores/advanced.svelte';
  import { sessions } from '../../stores/sessions.svelte';
  import { groups } from '../../stores/groups.svelte'; // [SSA-GROUP]
  import { learningGate } from '../../lib/learning/suggest-gate.svelte'; // [SSA-LEARN]

  interface Props {
    /** 进入子页 */
    onNavigate: (page: string) => void;
  }
  let { onNavigate }: Props = $props();

  const currentThemeName = $derived(
    THEMES.find((t) => t.id === theme.current)?.name ?? '—',
  );

  /**
   * 使用情况概览：直接显示缓存命中率，让用户不进页面也能判断缓存是否生效。
   * 无记录时**不显示「0%」**（会被误读成缓存失效），而是给一句可执行的说明——
   * 「暂无记录」看起来像功能没做，这里明确告诉用户「聊一句就会开始统计」。
   */
  const usageSummary = $derived.by(() => {
    const turns = sessions.list.reduce((n, s) => n + s.turns.length, 0);
    if (turns === 0) return '聊一句即开始统计';
    let input = 0;
    let cached = 0;
    for (const s of sessions.list) {
      for (const t of s.turns) {
        input += t.stats.inputTokens;
        cached += t.stats.cachedTokens;
      }
    }
    const rate = input > 0 ? ((cached / input) * 100).toFixed(0) : '0';
    return `${turns} 轮 · 命中 ${rate}%`;
  });

  /** 上下文策略显示名（A / M 双轨）。 */
  const ctxStrategy = $derived(
    ctxConfig.strategy === 'sl' ? '骨架-活簇（M）' : '原版逐条（A）',
  );
  const compressionState = $derived(
    ctxConfig.compactEnabled ? `开 · ${ctxConfig.compactRatio.toFixed(2)}` : '关闭',
  );
  const memoryState = $derived(
    memoryConfig.graphEnabled ? '摘要 + 关系' : '仅摘要',
  );
</script>

<div class="settings-page">
  <nav class="crumb" aria-label="当前位置">
    <span class="crumb-title">设置</span>
  </nav>

  <SettingGroup>
    <SettingRow label="连接" value="已内置" onclick={() => onNavigate('api')} />
    <SettingRow
      label="模型设置"
      value={modelConfig.model || '后端默认'}
      onclick={() => onNavigate('model')}
    />
    <SettingRow label="预设" value={modelConfig.preset} onclick={() => onNavigate('preset')} />
    <!-- 使用情况放在第一组：它统计的就是模型调用与缓存命中，与上面三项同域；
         同时保证首屏可见（此前埋在第 7 组，用户反馈「做好了但没看见」）。 -->
    <SettingRow label="使用情况" value={usageSummary} onclick={() => onNavigate('usage')} />
  </SettingGroup>

  <SettingGroup>
    <SettingRow
      label="上下文参数"
      desc="预算 / 故事串接 / 分隔符"
      value={`${modelConfig.maxContext}`}
      onclick={() => onNavigate('ctx-params')}
    />
    <SettingRow
      label="指令模式"
      value={advanced.get('instructEnabled') ? '已启用' : '未启用'}
      onclick={() => onNavigate('instruct')}
    />
  </SettingGroup>

  <SettingGroup>
    <SettingRow
      label="上下文策略"
      desc="原版逐条注入 或 骨架-活簇双层，双轨保留"
      value={ctxStrategy}
      onclick={() => onNavigate('context')}
    />
    <SettingRow
      label="上下文压缩"
      desc="长对话折叠旧内容，避免超出模型上限"
      value={compressionState}
      onclick={() => onNavigate('compact')}
    />
    <SettingRow label="世界书" onclick={() => onNavigate('worldbook')} />
    <SettingRow
      label="长记忆"
      desc="摘要主干 + 关系索引"
      value={memoryState}
      onclick={() => onNavigate('memory')}
    />
  </SettingGroup>

  <SettingGroup>
    <SettingRow label="角色" onclick={() => onNavigate('characters')} />
    <SettingRow
      label="用户身份"
      value={modelConfig.userName}
      onclick={() => onNavigate('persona')}
    />
  </SettingGroup>

  <SettingGroup>
    <SettingRow label="外观" value={currentThemeName} onclick={() => onNavigate('appearance')} />
    <SettingRow label="聊天设置" onclick={() => onNavigate('chat')} />
  </SettingGroup>

  <SettingGroup>
    <SettingRow label="正则" onclick={() => onNavigate('regex')} />
    <SettingRow label="插件" value="0 个" onclick={() => onNavigate('plugins')} />
  </SettingGroup>

  <!-- 群聊（实验）：flag 默认关；开启后「角色」页出现多选开聊入口 // [SSA-GROUP] -->
  <SettingGroup title="群聊（实验）">
    <SettingRow
      kind="toggle"
      label="启用群聊"
      desc="在「角色」页多选成员即可开聊；记录存本机独立存储，不影响单角色会话"
      checked={groups.enabled}
      onchange={(v) => groups.setEnabled(v)}
    />
    <SettingRow
      label="发言人规则"
      value="本地状态机"
      desc="按角色网络与触发矩阵选择发言者，不额外调用模型"
    />
  </SettingGroup>

  <!-- 学习（实验）：flag 默认关；开启后出现「学习建议」入口 // [SSA-LEARN] -->
  <SettingGroup title="学习（实验）">
    <SettingRow
      kind="toggle"
      label="启用学习"
      desc="从本机单角色对话里归纳场景词与句式模板，供你逐条确认；采纳才写入"
      checked={learningGate.enabled}
      onchange={(v) => learningGate.setEnabled(v)}
    />
    {#if learningGate.enabled}
      <SettingRow
        label="学习建议"
        desc="逐条采纳 / 编辑 / 拒绝；采纳后写进选定的世界书，可撤销"
        value={learningGate.tally.applied + learningGate.tally.edited > 0
          ? `已采纳 ${learningGate.tally.applied + learningGate.tally.edited} 条`
          : '未采纳'}
        onclick={() => onNavigate('learning')}
      />
    {/if}
  </SettingGroup>

  <SettingGroup>
    <SettingRow label="存储空间" onclick={() => onNavigate('storage')} />
    <SettingRow label="备份与恢复" onclick={() => onNavigate('backup')} />
  </SettingGroup>

  <SettingGroup>
    <SettingRow label="帮助中心" onclick={() => onNavigate('help')} />
    <SettingRow label="关于 Tavern" value="0.1.0" onclick={() => onNavigate('about')} />
  </SettingGroup>
</div>

<style>
  .settings-page {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    padding-bottom: var(--gap-lg);
    min-height: 0;
  }
  .crumb {
    flex-shrink: 0;
  }
  .crumb-title {
    font-size: 1.25rem;
    font-weight: 700;
  }
</style>
