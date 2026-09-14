<script lang="ts">
  /**
   * 设置容器（Tavo 式列表导航）。
   *
   * 结构：主页 = 分组列表；点子项 → 推入子页；子页返回 → 回主页。
   * 用一层浅路由而非 URL 路由 —— 设置是线性下钻，不需要深链接，
   * 保持「返回即回上一层」的直觉，并让 Android 返回键语义简单。
   */
  import SettingsHome from './settings/SettingsHome.svelte';
  import ContextPage from './settings/ContextPage.svelte';
  import CompactPage from './settings/CompactPage.svelte';
  import ContextParamsPage from './settings/ContextParamsPage.svelte';
  import InstructPage from './settings/InstructPage.svelte';
  import ModelPage from './settings/ModelPage.svelte';
  import MemoryPage from './settings/MemoryPage.svelte';
  import WorldbookPage from './settings/WorldbookPage.svelte';
  import ConnectionPage from './settings/ConnectionPage.svelte';
  import AppearancePage from './settings/AppearancePage.svelte';
  import PersonaPage from './settings/PersonaPage.svelte';
  import ChatSettingsPage from './settings/ChatSettingsPage.svelte';
  import WritingStylePage from './settings/WritingStylePage.svelte';
  import UsagePage from './settings/UsagePage.svelte';
  import LearningPage from './settings/LearningPage.svelte'; // [SSA-LEARN]
  import PlaceholderPage from '../lib/settings/PlaceholderPage.svelte';
  import { pushBack } from '../lib/back';

  type Page =
    | 'home'
    | 'context'
    | 'compact'
    | 'ctx-params'
    | 'instruct'
    | 'model'
    | 'memory'
    | 'worldbook'
    | 'api'
    | 'appearance'
    | 'persona'
    | 'chat'
    | 'writing'
    | 'usage'
    | 'learning'
    | 'preset'
    | 'characters'
    | 'regex'
    | 'plugins'
    | 'storage'
    | 'backup'
    | 'help'
    | 'about';

  let page = $state<Page>('home');
  const back = () => (page = 'home');

  /**
   * 返回键处理（优先级 50）：处于子页时回到设置首页并消费返回，
   * 已在首页则放行给下一级（App 末级 handler → 原生）。
   */
  $effect(() => {
    const off = pushBack(() => {
      if (page !== 'home') {
        page = 'home';
        return true;
      }
      return false;
    }, 50);
    return off;
  });
</script>

{#if page === 'home'}
  <SettingsHome onNavigate={(p) => (page = p as Page)} />
{:else if page === 'context'}
  <ContextPage onBack={back} />
{:else if page === 'compact'}
  <CompactPage onBack={back} />
{:else if page === 'ctx-params'}
  <ContextParamsPage onBack={back} />
{:else if page === 'instruct'}
  <InstructPage onBack={back} />
{:else if page === 'model'}
  <ModelPage onBack={back} />
{:else if page === 'memory'}
  <MemoryPage onBack={back} />
{:else if page === 'worldbook'}
  <WorldbookPage onBack={back} />
{:else if page === 'api'}
  <ConnectionPage onBack={back} />
{:else if page === 'appearance'}
  <AppearancePage onBack={back} />
{:else if page === 'persona'}
  <PersonaPage onBack={back} />
{:else if page === 'chat'}
  <ChatSettingsPage onBack={back} />
{:else if page === 'writing'}
  <WritingStylePage onBack={back} />
{:else if page === 'usage'}
  <UsagePage onBack={back} />
{:else if page === 'learning'}
  <LearningPage onBack={back} />
{:else if page === 'preset'}
  <PlaceholderPage
    title="预设"
    desc="保存与切换整套模型参数组合。"
    onBack={back}
  />
{:else if page === 'characters'}
  <PlaceholderPage
    title="角色"
    desc="角色卡的管理、导入与分组。"
    onBack={back}
  />
{:else if page === 'regex'}
  <PlaceholderPage
    title="正则"
    desc="对输入与输出做查找替换，用于清理格式或屏蔽内容。"
    onBack={back}
  />
{:else if page === 'plugins'}
  <PlaceholderPage
    title="插件"
    desc="扩展能力的管理与更新。"
    onBack={back}
  />
{:else if page === 'storage'}
  <PlaceholderPage
    title="存储空间"
    desc="查看聊天记录与资源占用，按需清理。"
    onBack={back}
  />
{:else if page === 'backup'}
  <PlaceholderPage
    title="备份与恢复"
    desc="导出全部设置与聊天记录，或从备份还原。"
    onBack={back}
  />
{:else if page === 'help'}
  <PlaceholderPage
    title="帮助中心"
    desc="常见问题、使用提示与反馈渠道。"
    onBack={back}
  />
{:else}
  <PlaceholderPage
    title="关于"
    desc="Tavern · 本地酒馆客户端"
    onBack={back}
  />
{/if}
