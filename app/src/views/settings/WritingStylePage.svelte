<script lang="ts">
  /**
   * 写作风格设置页。
   *
   * 设计约束（见 `docs/写作风格引擎-接入设计.md`）：
   *  · 风格块进**冻结前缀区**，改任何一项都会让下一轮前缀重建一次 → 页内显式提示；
   *  · 文案一律**正向指定**，不列禁用清单（禁用清单会反向激活被点名的行为）；
   *  · 本页自带「当前注入内容」预览：提示词工程必须可见可审，否则用户只能靠猜。
   */
  import SubPage from '../../lib/settings/SubPage.svelte';
  import SettingGroup from '../../lib/settings/SettingGroup.svelte';
  import SettingRow from '../../lib/settings/SettingRow.svelte';
  import SettingText from '../../lib/settings/SettingText.svelte';
  import Field from '../../lib/settings/Field.svelte';
  import { writingStyle } from '../../stores/writing-style.svelte';
  import { DEPTHS, LENSES, type DepthKey, type LensKey } from '../../lib/style/types';
  import { GUIDE_TOKEN_BUDGET, SAMPLE_MAX_CHARS, styleTokens } from '../../lib/style/guide';

  interface Props {
    onBack: () => void;
  }
  let { onBack }: Props = $props();

  const tokens = $derived(writingStyle.tokens);
  const overBudget = $derived(tokens > GUIDE_TOKEN_BUDGET);
  const guide = $derived(writingStyle.guide);

  const depthOptions = DEPTHS.map((d) => ({ value: d.key, label: d.label }));
  const lensOptions = LENSES.map((l) => ({ value: l.key, label: l.label }));
  const depthHint = $derived(DEPTHS.find((d) => d.key === writingStyle.state.depth)?.hint ?? '');
  const lensHint = $derived(LENSES.find((l) => l.key === writingStyle.state.lens)?.hint ?? '');
</script>

<SubPage title="写作风格" {onBack}>
  <SettingGroup title="语体">
    <SettingRow
      kind="toggle"
      label="聊天体"
      desc="按人在手机上聊天的语用写：短句连发、语气词当标点、会走神、会用「嗯」「然后呢」这种不推进事情的应答"
      checked={writingStyle.state.register}
      onchange={(v) => writingStyle.set('register', v)}
    />
    <SettingRow
      kind="toggle"
      label="分条发送"
      desc="短消息一条一个气泡（像手机连发）；成段的描写不会被切开。只改显示——发给模型的内容和落盘的记录都仍是完整一段"
      checked={writingStyle.state.burst}
      onchange={(v) => writingStyle.set('burst', v)}
    />
  </SettingGroup>

  <SettingGroup title="尺度（允许写到哪，不要求写到哪）">
    <SettingRow label="上限" desc={depthHint}>
      {#snippet trailing()}
        <Field
          kind="select"
          value={writingStyle.state.depth}
          options={depthOptions}
          onchange={(v) => writingStyle.set('depth', v as DepthKey)}
        />
      {/snippet}
    </SettingRow>
    <SettingRow label="视角" desc={lensHint}>
      {#snippet trailing()}
        <Field
          kind="select"
          value={writingStyle.state.lens}
          options={lensOptions}
          onchange={(v) => writingStyle.set('lens', v as LensKey)}
        />
      {/snippet}
    </SettingRow>
    <SettingRow
      label="模型看到的是一句话"
      kind="static"
      desc="这一页只决定上面这段文字，不改写作要求之外的东西；角色卡说什么、世界书给什么设定，都不受影响"
    />
  </SettingGroup>

  <SettingGroup title="风格样本">
    <SettingText
      label="粘贴一段你写的或你认可的文字"
      desc="必须是真人写的。模型会贴合它的节奏、用词密度与叙述距离——这一项对语感的锚定比任何形容词都强，用 AI 生成的字当样本会把 AI 的腔调一起带进来。"
      value={writingStyle.state.sample}
      placeholder={'例如：一个真实的人在某次聊天里的几段话，或你写的一小段小说片段。\n不必完整，节奏对就够。'}
      rows={6}
      onchange={(v) => writingStyle.set('sample', v)}
    />
    <SettingRow
      label="样本长度"
      kind="static"
      value={`${writingStyle.state.sample.length} / ${SAMPLE_MAX_CHARS} 字`}
      desc="超长会被截断，并归一化换行与空行（保证同一段文本在任何设备上写入的字节一致）"
    />
  </SettingGroup>

  <SettingGroup title="前缀占用与缓存">
    <SettingRow
      label="风格块占用"
      kind="static"
      value={`约 ${tokens} tokens`}
      desc={overBudget
        ? `已超过建议上限 ${GUIDE_TOKEN_BUDGET}：这段文字进的是前缀区，长对话里会随轮数反复计费，建议精简样本`
        : `建议控制在 ${GUIDE_TOKEN_BUDGET} tokens 以内：风格块属前缀区，会随轮数反复计费`}
    />
    <SettingRow
      label="改完设置之后"
      kind="static"
      desc="下一轮缓存命中会掉一次（前缀被重建），从再下一轮起恢复正常。这是缓存机制的正常表现，不是故障。"
    />
  </SettingGroup>

  <SettingGroup title="当前注入内容">
    {#if guide}
      <details class="preview">
        <summary>展开看模型实际收到的这一块</summary>
        <pre>{guide}</pre>
      </details>
    {:else}
      <SettingRow label="不注入" kind="static" desc="当前设置生成的是空块，请求体与未接入前完全一致" />
    {/if}
  </SettingGroup>
</SubPage>

<style>
  .preview {
    padding: 12px var(--gap-lg) 14px;
  }
  .preview summary {
    font-size: 0.82rem;
    color: var(--text-dim);
    cursor: pointer;
  }
  .preview pre {
    margin: 10px 0 0;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
