<script lang="ts">
  /**
   * 聊天主视图。
   *
   * 产品原则：用户看到的是「能聊」或「不能聊」，不是 node 版本 / fallback / IP:端口。
   * 实现细节一律走 logger，仅在调试面板可见。
   */
  import { onMount, onDestroy } from 'svelte';
  import MessageBubble from '../lib/MessageBubble.svelte';
  import Avatar from '../lib/Avatar.svelte';
  import { probeBackend, characterAvatarUrl, type ServiceState } from '../lib/backend';
  import { generateReply, type TokenUsage } from '../lib/chat';
  import { buildContext, mergeUsage } from '../lib/chat-context';
  import type { FactSlotState } from '../lib/context/assembler';
  import type { TurnStats } from '../lib/chat-stats';
  import { characters } from '../stores/characters.svelte';
  import { modelConfig } from '../stores/model.svelte';
  import { ctxConfig } from '../stores/context.svelte';
  import { worldbook } from '../stores/worldbook.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { logger } from '../lib/logger';
  import { pushBack } from '../lib/back';

  interface Msg {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    /** 用量统计（用户消息记「本轮输入」，助手消息记「本轮输出」） */
    stats?: TurnStats;
    /** 用户消息附带的图片（data URL 数组） */
    images?: string[];
    /** 所属轮次 id（用于撤销/改写/重新生成定位；进行中一轮无 id） */
    turnId?: string;
  }

  interface Props {
    /** 跳转到「角色」页（角色选择在那里完成，本页只展示当前角色） */
    onOpenCharacters?: () => void;
  }
  let { onOpenCharacters }: Props = $props();

  let service = $state<ServiceState>('starting');
  let draft = $state('');
  let scroller: HTMLDivElement | undefined;

  /** 生成中：禁止并发发送，并显示「正在输入」 */
  let generating = $state(false);
  let errorText = $state('');
  let abortCtl: AbortController | null = null;

  /**
   * 「改写并重新生成」的编辑框状态（null = 关闭）。
   * 预填原用户消息文本与图片，确认后以新文本重走生成路径。
   */
  let editing = $state<{ turnId: string; text: string; images?: string[] } | null>(null);

  /** 单条消息最多附带的图片张数（受 localStorage 配额约束） */
  const MAX_IMAGES = 4;
  /** 本地图片 file input（隐藏，由按钮触发） */
  let fileInput: HTMLInputElement | undefined;
  /** 已选待发送的图片（data URL） */
  let selectedImages = $state<string[]>([]);
  /** 图片处理过程中的可见提示（如超出张数限制） */
  let imageHint = $state('');

  /**
   * 本地压缩：最长边限制到 MAX_EDGE px，转 JPEG（质量 0.8）data URL。
   *
   * 为什么必须压缩：项目只有 localStorage（无 IndexedDB），原图 base64 极易
   * 撑爆配额 —— 一旦 setItem 抛异常会导致整个键写入失败、连带丢数据。
   */
  const MAX_EDGE = 1024;
  async function compressImage(file: File): Promise<string> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      throw new Error('无法创建画布上下文');
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  async function onPickImages(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = ''; // 允许再次选择同名文件
    if (files.length === 0) return;

    imageHint = '';
    const room = MAX_IMAGES - selectedImages.length;
    if (room <= 0) {
      imageHint = `最多只能附 ${MAX_IMAGES} 张图片`;
      return;
    }
    let skipped = files.length > room ? files.length - room : 0;

    const picked: string[] = [];
    for (const file of files.slice(0, room)) {
      try {
        picked.push(await compressImage(file));
      } catch (err) {
        skipped++;
        logger.warn('chat', '图片处理失败', err);
      }
    }
    selectedImages = [...selectedImages, ...picked];
    if (skipped > 0) imageHint = `已忽略 ${skipped} 张（最多 ${MAX_IMAGES} 张，或无法处理）`;
  }

  function removeImage(index: number) {
    selectedImages = selectedImages.filter((_, i) => i !== index);
    if (selectedImages.length === 0) imageHint = '';
  }

  function openFilePicker() {
    fileInput?.click();
  }

  /**
   * 进行中的一轮（未落盘）。
   *
   * 为什么需要：已完成的轮次从会话 store 派生（持久），而正在流式生成的这一轮
   * 还没写库。若直接往 store 里写半成品，中断/失败时就会留下脏数据。
   * 因此用一层临时状态叠加在派生消息之上，只在成功时才 `appendTurn` 落盘。
   */
  let pending = $state<{
    userText: string;
    assistantText: string;
    stats: TurnStats | null;
    images?: string[];
  } | null>(null);

  /** 对话列表是否展开 */
  let convOpen = $state(false);

  /** 对话列表里的时间显示（今天只显示时分，其它显示日期） */
  function fmtTime(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()}`;
  }

  const activeChar = $derived(characters.fallback);
  /**
   * 当前角色头像的绝对 URL。
   * 必须绝对化：页面 origin 是 https://localhost，根相对路径命中不了
   * 127.0.0.1:4444 的后端（见 backend.ts mediaUrl 注释）。
   */
  const activeAvatarUrl = $derived(characterAvatarUrl(activeChar?.avatar));
  const canSend = $derived(
    (!!draft.trim() || selectedImages.length > 0) && service === 'ready' && !generating,
  );

  // ── 会话（对话线）──────────────────────────────────────────────────────
  /** 事实槽状态（跨轮持久；append-only 冻结后字节恒定，利于前缀缓存）。
   *  注意：它属于**单条对话**的上下文状态，切换对话时必须重置。 */
  let factState: FactSlotState | null = null;
  /** 当前角色名（会话归属键） */
  const charName = $derived(activeChar?.name ?? '角色');
  /** 当前角色的全部对话（最新在前） */
  const charSessions = $derived(sessions.listFor(charName));
  /** 当前打开的对话 */
  const activeSession = $derived(sessions.active);

  /**
   * 渲染用的消息列表 = 已落盘的轮次（派生） + 进行中的一轮（临时）。
   *
   * 单一事实来源：消息不再单独存一份，而是由 `session.turns` 派生
   * （见 sessions.svelte.ts 文件头说明）。这样「聊天气泡」与「统计页」
   * 永远一致，不会出现两边对不上的情况。
   */
  const messages = $derived.by<Msg[]>(() => {
    const out: Msg[] = [];
    const s = activeSession;
    if (s) {
      for (const t of s.turns) {
        out.push({ id: `${t.id}-u`, role: 'user', text: t.userText, stats: t.stats, images: t.images, turnId: t.id });
        // 助手回复被「撤销」后 assistantText 为空 —— 一律不渲染空气泡。
        // 进行中一轮的「正在思考」占位来自下方的 pending-a（而非库里的空轮次），
        // 故这里**无需**按 generating 放行；否则历史空轮会与 pending 重复占位。
        if (t.assistantText) {
          out.push({ id: `${t.id}-a`, role: 'assistant', text: t.assistantText, stats: t.stats, turnId: t.id });
        }
      }
    }
    if (pending) {
      const base = pending.stats;
      out.push({
        id: 'pending-u',
        role: 'user',
        text: pending.userText,
        images: pending.images,
        // 用户气泡只标输入：把输出清零（与落盘后的口径一致）
        stats: base ? { ...base, outputTokens: 0 } : undefined,
      });
      out.push({ id: 'pending-a', role: 'assistant', text: pending.assistantText, stats: base ?? undefined });
    }
    return out;
  });

  /** 切换对话（重新载入该对话的消息）。 */
  function switchSession(id: string) {
    if (generating) return;
    sessions.switchTo(id);
    // 事实槽属于「单条对话」的上下文状态，切对话必须重置
    factState = null;
    scrollToBottom();
  }

  /**
   * 新建对话。
   *
   * 若当前对话本就是空的（还没聊），不重复创建 —— 否则连点几次会在列表里
   * 累积一串空的「新对话」条目。此时它已经是「新对话」，无需再新。
   */
  async function newSession() {
    if (generating) return;
    // 与发送同理：角色名未就绪时会建出归属占位符的孤儿对话
    await ensureCharacters();
    const cur = sessions.active;
    if (!(cur && cur.characterName === charName && cur.turns.length === 0)) {
      sessions.create(charName);
    }
    factState = null;
    convOpen = false;
    scrollToBottom();
  }

  /** 删除对话。 */
  function removeSession(id: string, e: MouseEvent) {
    e.stopPropagation();
    if (generating) return;
    if (!confirm('删除这条对话？此操作不可撤销。')) return;
    sessions.remove(id);
    factState = null;
  }

  async function refresh() {
    service = 'starting';
    const { state, info } = await probeBackend();
    service = state;
    if (state === 'ready') {
      await characters.load();
      // 自愈：把时序窗口期间写成占位符归属的对话迁到真实角色名下（幂等）
      sessions.adoptOrphans(characters.list.map((c) => c.name));
      // 世界书是上下文组装的输入；加载失败不影响聊天（降级为仅角色设定）
      await worldbook.load();
      logger.debug('chat', '后端就绪', {
        count: characters.list.length,
        worlds: worldbook.list.length,
        entries: worldbook.entries.length,
        full: info?.fullFeatured,
      });
    }
  }

  function scrollToBottom() {
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  /** 已加载世界书的条目（活动世界书变化时刷新） */
  const activeEntries = $derived(worldbook.entriesFor({ liveCluster: ctxConfig.liveClusterWorldbook }));

  /**
   * 组装本轮上下文（A/M 双轨）。
   *
   * 具体规则在 `lib/chat-context.ts` 的纯函数里（可单测），此处只负责
   * 从各 store 取值并回写事实槽状态。
   */
  function turnsFor(history: Msg[]): ReturnType<typeof buildContext> {
    const out = buildContext({
      entries: activeEntries,
      history,
      charName: activeChar?.name ?? '角色',
      charDescription: activeChar?.description,
      cfg: {
        ...ctxConfig.toSsaConfig(),
        // 预算帽基数必须与模型设置里的上下文上限一致，否则预算与实际窗口脱节
        maxContext: modelConfig.maxContext,
      },
      factState: factState ?? undefined,
    });
    // 事实槽 append-only 推进，需跨轮保持
    if (out.factState) factState = out.factState;
    return out;
  }

  /**
   * 确保角色列表已就绪，再允许写入会话。
   *
   * 为什么必须等：会话以**角色名**作归属键（见 sessions.svelte.ts 文件头）。
   * `refresh()` 里 `service` 会先于 `characters.load()` 变成 ready，
   * 这个窗口内发送会让 `charName` 落到占位符 `'角色'`，建出一条
   * `characterName:'角色'` 的会话；待真实角色名就绪后 `listFor(真实名)`
   * 与顶栏下拉框都找不到它 —— 表现为「首条对话没被保存」（2026-09-13 实测复现）。
   *
   * `load()` 只在拿到结果后才置 `loaded = true`，故不存在「假就绪」。
   */
  async function ensureCharacters() {
    if (!characters.loaded) await characters.load();
  }

  async function send() {
    const text = draft.trim();
    const images = selectedImages;
    if ((!text && images.length === 0) || service !== 'ready' || generating) return;
    draft = '';
    selectedImages = [];
    imageHint = '';
    await sendText(text, images);
  }

  /**
   * 生成一轮回复的核心路径（发送 / 改写并重新生成 / 重新生成 三处共用）。
   *
   * 语义与原来的 `send()` 完全一致：组装上下文 → 流式生成 → appendTurn 落盘。
   * 抽出后 `send()` 只负责从输入框取文本与图片并清空输入框，本函数只负责生成。
   * 调用方需自行保证前置条件（service === 'ready' 且不在 generating）。
   *
   * @param text  本轮用户消息文本
   * @param images 本轮用户消息附带的图片（可为空数组）
   */
  async function sendText(text: string, images: string[]) {
    // 防御性前置校验：三个入口（发送/改写/重新生成）共用，避免某入口漏判
    if (service !== 'ready' || generating || (!text && images.length === 0)) return;
    errorText = '';
    // 角色列表可能尚未返回（refresh 的时序窗口）→ 先补齐，否则会话会归到占位符名下
    await ensureCharacters();
    // 打开当前角色的对话（无则新建；有则保持当前对话不切换）
    sessions.openFor(charName);

    // 组装上下文：历史取已落盘轮次（pending 尚未落盘，不参与）
    const storedHistory = messages.filter((m) => !m.id.startsWith('pending-'));
    const { turns, stats: baseStats } = turnsFor([
      ...storedHistory,
      { id: 'tmp', role: 'user', text, images: images.length > 0 ? images : undefined },
    ]);

    // 进入「进行中」状态：用户消息与助手占位都走临时层，避免写半成品进库
    pending = {
      userText: text,
      assistantText: '',
      stats: { ...baseStats, outputTokens: 0 },
      images: images.length > 0 ? images : undefined,
    };
    generating = true;
    scrollToBottom();

    abortCtl = new AbortController();
    const startedAt = Date.now();

    try {
      const result = await generateReply(
        {
          messages: turns,
          model: modelConfig.model,
          temperature: modelConfig.temp,
          frequencyPenalty: modelConfig.freqPen,
          presencePenalty: modelConfig.presPen,
          topP: modelConfig.topP,
          maxTokens: modelConfig.maxTokens,
          stream: modelConfig.stream,
          thinking: modelConfig.thinking,
          source: 'custom',
          customUrl: modelConfig.apiUrl || undefined,
          apiKey: modelConfig.apiKey || undefined,
          userName: modelConfig.userName,
          charName,
          signal: abortCtl.signal,
        },
        (full) => {
          // 流式：只更新临时层，库不动
          if (pending) pending = { ...pending, assistantText: full };
          scrollToBottom();
        },
      );

      let finalText = result.text.trim();
      if (!finalText) {
        finalText = result.reasoning ? '（模型只返回了思考内容，没有正文）' : '（模型没有返回内容）';
      }

      // API 实测优先；无 usage 时保留本地估算并标注
      const usage: TokenUsage | undefined = result.usage;
      const replyStats = mergeUsage(baseStats, usage, finalText);

      // 成功 → 落盘（此后消息由 store 派生，pending 清空）
      sessions.appendTurn({
        at: Date.now(),
        userText: text,
        assistantText: finalText,
        images: images.length > 0 ? images : undefined,
        durationMs: Date.now() - startedAt,
        model: modelConfig.model || '后端默认',
        stats: replyStats,
      });
      pending = null;

      logger.debug('chat', '本轮完成', {
        chars: finalText.length,
        input: replyStats.inputTokens,
        output: replyStats.outputTokens,
        cached: replyStats.cachedTokens,
        measured: replyStats.inputMeasured,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 用户主动中断不算错误：丢弃本轮（含用户消息，避免留下无回复的孤轮）
      if (msg.includes('abort')) {
        pending = null;
      } else {
        errorText = msg;
        pending = null;
        logger.error('chat', '发送失败', msg);
      }
    } finally {
      generating = false;
      abortCtl = null;
      scrollToBottom();
    }
  }

  function stop() {
    abortCtl?.abort();
  }

  // ── 消息级操作（长按 / 右键菜单回调）────────────────────────────────────
  // 设计选择：生成中一律**禁止**这些操作（而不是 abort 后执行）。理由：
  // 与进行中的流并发改动 turns 会让「正在落盘的那一轮」与截断结果相互覆盖，
  // 产生难以复现的脏数据；直接禁止最安全，且菜单项在生成中不会被触发（气泡仍在
  // 但用户更可能在等待）。下方每个处理器入口都有 generating 守卫。
  /** 截断后事实槽需重置（对话被回退，append-only 的槽状态不再适用） */
  function rewindFactState() {
    factState = null;
  }

  /** 撤销（用户消息）：删除该轮及其下所有内容。 */
  function undoFromUser(turnId: string) {
    if (generating) return;
    sessions.truncateFrom(turnId);
    rewindFactState();
    scrollToBottom();
  }

  /** 撤销（助手消息）：清空该回复及其下内容，保留该轮用户消息。 */
  function undoAssistant(turnId: string) {
    if (generating) return;
    sessions.clearAssistantFrom(turnId);
    rewindFactState();
    scrollToBottom();
  }

  /** 打开「改写」编辑框，预填该用户消息原文与图片。 */
  function rewriteUser(turnId: string) {
    if (generating) return;
    const t = sessions.active?.turns.find((x) => x.id === turnId);
    if (!t) return;
    editing = { turnId, text: t.userText, images: t.images };
  }

  /** 确认改写：丢弃该轮及其下内容后，以新文本重走生成路径。 */
  async function confirmRewrite() {
    if (!editing || generating) return;
    const { turnId, text, images } = editing;
    const next = text.trim();
    if (!next && (images?.length ?? 0) === 0) return; // 空文本且无图：不提交
    editing = null;
    // 丢弃该用户消息及其下所有内容，再以改写后的文本重新生成
    sessions.truncateFrom(turnId);
    rewindFactState();
    await sendText(next, images ?? []);
  }

  /** 重新生成助手回复：丢弃该轮及其下内容，以原用户文本重走生成路径。 */
  async function regenerateAssistant(turnId: string) {
    if (generating) return;
    const t = sessions.active?.turns.find((x) => x.id === turnId);
    if (!t) return;
    // 先取出用户文本与图片（截断后该轮已不在 turns 中）
    const userText = t.userText;
    const images = t.images ?? [];
    sessions.truncateFrom(turnId);
    rewindFactState();
    await sendText(userText, images);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  onMount(() => {
    refresh();
    // 视觉验证用：?demo=1 预置一段演示对话（走真实渲染路径）
    if (new URLSearchParams(location.search).get('demo') === '1') {
      // appendTurn 需要一个活跃对话；演示模式下显式创建
      if (!sessions.active) sessions.create('看板娘');
      const demo = [
        ['给我讲讲这座城的故事吧。', '这座城建在两条河的交汇处，三百年前还只是个渡口。后来商队发现这里的琥珀成色极好，于是……'],
        ['那场大火呢？', '大火烧了三天三夜，把半个渡口区烧成了白地。有人说那不是意外。'],
      ];
      for (const [u, a] of demo) {
        sessions.appendTurn({
          at: Date.now(),
          userText: u,
          assistantText: a,
          durationMs: 1200,
          model: 'demo',
          stats: {
            inputTokens: 1500,
            outputTokens: 60,
            cachedTokens: 1024,
            inputMeasured: true,
            breakdown: { prefix: 29, suffix: 12, liveClusters: 3, facts: 120, leaf: 80 },
          },
        });
      }
    }
  });

  /**
   * 角色变化时跟随到该角色的对话，**但不新建**。
   *
   * 为什么不在这里新建：无条件新建会让「刚打开应用、还没聊天」也留下一条空对话，
   * 列表里于是出现幽灵「新对话」条目（实测确认过）。真正需要落盘对话的时机
   * 只有一个 —— 用户发出第一条消息时（见 send 里的 openFor）。
   * 此处只做「切到该角色已有的最近对话」。
   */
  $effect(() => {
    if (!charName) return;
    const cur = sessions.active;
    if (cur && cur.characterName === charName) return;
    const existing = sessions.listFor(charName);
    if (existing.length > 0) sessions.switchTo(existing[0].id);
  });

  /**
   * 返回键处理（优先级 100，最高）：对话列表抽屉展开时先收起抽屉，
   * 否则放行给下一级（设置子页 → App 末级 → 原生）。
   */
  $effect(() => {
    const off = pushBack(() => {
      if (convOpen) {
        convOpen = false;
        return true;
      }
      return false;
    }, 100);
    return off;
  });

  onDestroy(() => abortCtl?.abort());
</script>

<div class="chat">
  <!-- 顶栏：角色 + 当前对话（点对话名展开切换列表） -->
  <header class="topbar glass">
    <div class="who">
      <Avatar src={activeAvatarUrl} name={activeChar?.name} fallbackChar="T" size={38} />
      <div class="who-text">
        <div class="who-name">{activeChar?.name ?? 'Tavern'}</div>
        <!-- 当前对话名：点击展开列表。放在角色名下方，让「角色 → 多条对话」的层级一眼可见 -->
        <button
          class="who-conv"
          onclick={() => (convOpen = !convOpen)}
          aria-expanded={convOpen}
          aria-label="切换对话"
          disabled={generating}
        >
          <span class="truncate">{activeSession?.title ?? '新对话'}</span>
          {#if charSessions.length > 1}
            <span class="conv-count">{charSessions.length}</span>
          {/if}
          <svg class="chev" class:open={convOpen} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
    <div class="topbar-actions">
      <button class="icon-btn" onclick={newSession} disabled={generating} aria-label="新建对话" title="新建对话">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      {#if onOpenCharacters}
        <button class="switch-char" onclick={onOpenCharacters} aria-label="切换角色">
          <svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 00-2 2v3m0 8v3a2 2 0 002 2h3m8-18h3a2 2 0 012 2v3m0 8v3a2 2 0 01-2 2h-3" /></svg>
          <span>切换</span>
        </button>
      {/if}
    </div>
  </header>

  <!-- 对话列表：当前角色的全部对话线（切换 / 新建 / 删除） -->
  {#if convOpen}
    <div class="conv-list glass">
      <div class="conv-head">
        <span class="conv-title">{activeChar?.name ?? '角色'} 的对话</span>
        <span class="conv-n">{charSessions.length}</span>
      </div>
      {#if charSessions.length === 0}
        <p class="conv-empty">还没有对话，发一条消息就会自动创建。</p>
      {:else}
        {#each charSessions as s (s.id)}
          <div class="conv-row" class:active={s.id === activeSession?.id}>
            <button class="conv-pick" onclick={() => { switchSession(s.id); convOpen = false; }}>
              <span class="conv-name">{s.title}</span>
              <span class="conv-meta">
                {s.turns.length} 轮 · {fmtTime(s.updatedAt)}
              </span>
            </button>
            <button
              class="conv-del"
              onclick={(e) => removeSession(s.id, e)}
              aria-label="删除对话"
              title="删除"
            >
              <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        {/each}
      {/if}
      <button class="conv-new" onclick={() => { newSession(); convOpen = false; }} disabled={generating}>
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        <span>新建对话</span>
      </button>
    </div>
  {/if}

  <!-- 消息区 -->
  <div class="messages" bind:this={scroller}>
    {#if messages.length === 0}
      <div class="empty animate-fade-in">
        {#if service === 'starting'}
          <div class="spinner" aria-label="正在启动"></div>
          <p class="text-dim">正在准备…</p>
        {:else if service === 'ready'}
          <div class="empty-mark">T</div>
          <h2>{activeChar ? activeChar.name : '开始对话'}</h2>
          <p class="text-dim">
            {characters.list.length > 0
              ? '点右上角「切换」挑一个角色，或直接输入开始对话。'
              : '直接输入即可开始。'}
          </p>
        {:else}
          <div class="empty-mark warn">!</div>
          <h2>暂时无法使用</h2>
          <p class="text-dim">请稍后重试，或检查网络连接。</p>
          <button class="btn btn-accent" onclick={refresh}>重试</button>
        {/if}
      </div>
    {:else}
      {#each messages as m (m.id)}
        {#if m.role === 'assistant' && !m.text && generating}
          <div class="thinking" aria-label="模型正在思考">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            <span class="thinking-text">正在思考…</span>
          </div>
        {:else}
          <!-- 仅对已落盘轮次（有 turnId）且非生成中注入操作回调；
               进行中的临时一轮（pending）不提供撤销/重生成，避免与流冲突 -->
          <MessageBubble
            role={m.role}
            text={m.text}
            stats={m.stats}
            images={m.images}
            avatarUrl={activeAvatarUrl}
            avatarName={activeChar?.name}
            canEditUser={m.role === 'user'}
            canRegenerate={m.role === 'assistant'}
            onUndo={!generating && m.turnId
              ? () => (m.role === 'user' ? undoFromUser(m.turnId!) : undoAssistant(m.turnId!))
              : undefined}
            onRewrite={!generating && m.turnId ? () => rewriteUser(m.turnId!) : undefined}
            onRegenerate={!generating && m.turnId ? () => regenerateAssistant(m.turnId!) : undefined}
          />
        {/if}
      {/each}
    {/if}
  </div>

  <!-- 输入区 -->
  {#if errorText}
    <div class="err glass" role="alert">
      <span class="err-text">{errorText}</span>
      <button class="err-close" onclick={() => (errorText = '')} aria-label="关闭提示">×</button>
    </div>
  {/if}

  <!-- 改写编辑框：预填原用户消息，确认后丢弃该轮及其下内容并重新生成 -->
  {#if editing}
    <div class="rewrite glass" role="dialog" aria-label="改写消息">
      <div class="rewrite-head">
        <span class="rewrite-title">改写消息</span>
        <button class="rewrite-close" onclick={() => (editing = null)} aria-label="取消">×</button>
      </div>
      <textarea
        class="rewrite-input"
        bind:value={editing.text}
        rows="3"
        aria-label="改写后的消息内容"
      ></textarea>
      <p class="rewrite-hint">确认后将丢弃该消息及其后的所有对话，并以新内容重新生成。</p>
      <div class="rewrite-actions">
        <button class="btn" onclick={() => (editing = null)}>取消</button>
        <button
          class="btn btn-accent"
          onclick={confirmRewrite}
          disabled={!editing.text.trim() && (editing.images?.length ?? 0) === 0}
        >确认并重新生成</button>
      </div>
    </div>
  {/if}

  <!-- 待发送图片：缩略图 + 单张删除 -->
  {#if selectedImages.length > 0 || imageHint}
    <div class="img-strip glass">
      {#if selectedImages.length > 0}
        <div class="img-thumbs">
          {#each selectedImages as src, i (i)}
            <div class="img-thumb">
              <img {src} alt="待发送图片 {i + 1}" />
              <button
                class="img-remove"
                onclick={() => removeImage(i)}
                aria-label="移除图片"
                title="移除"
              >×</button>
            </div>
          {/each}
        </div>
      {/if}
      {#if imageHint}
        <span class="img-hint">{imageHint}</span>
      {/if}
    </div>
  {/if}

  <div class="composer glass">
    <!-- 隐藏的图片选择器，由下方图片按钮触发 -->
    <input
      class="file-input"
      type="file"
      accept="image/*"
      multiple
      bind:this={fileInput}
      onchange={onPickImages}
    />
    <button
      class="icon-btn composer-img-btn"
      onclick={openFilePicker}
      disabled={service !== 'ready' || generating}
      aria-label="发送图片"
      title="发送图片"
    >
      <svg viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.6" />
        <path d="M4 17l5-5 4 4 3-3 4 4" />
      </svg>
    </button>
    <textarea
      class="composer-input"
      bind:value={draft}
      onkeydown={onKeydown}
      placeholder={generating ? '正在回复…' : service === 'ready' ? '说点什么…' : '正在准备…'}
      disabled={service !== 'ready'}
      rows="1"
      aria-label="消息输入"
    ></textarea>
    {#if generating}
      <button class="stop-btn" onclick={stop} aria-label="停止生成" title="停止">
        <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
      </button>
    {:else}
      <button
        class="send-btn"
        onclick={send}
        disabled={!canSend}
        aria-label="发送"
        title="发送"
      >
        <svg viewBox="0 0 24 24"><path d="M3 20l18-8L3 4v6l12 2-12 2v6z" /></svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    min-height: 0;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px var(--gap-lg);
    border-radius: var(--radius-2xl);
    flex-shrink: 0;
  }
  .who {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    min-width: 0;
  }
  .who-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .who-name {
    font-weight: 700;
    font-size: 0.95rem;
    line-height: 1.3;
  }

  /* 当前对话名（点开切换列表）：低对比、带 chevron，明确是可点的 */
  .who-conv {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 46vw;
    padding: 1px 4px 1px 0;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast) var(--ease-standard);
  }
  .who-conv:hover:not(:disabled) {
    color: var(--accent);
  }
  .who-conv:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .conv-count {
    flex-shrink: 0;
    min-width: 15px;
    padding: 0 3px;
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.6rem;
    font-weight: 700;
    text-align: center;
    line-height: 1.5;
  }
  .who-conv .chev {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform var(--dur-fast) var(--ease-standard);
  }
  .who-conv .chev.open {
    transform: rotate(180deg);
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    flex-shrink: 0;
  }
  .icon-btn {
    width: 34px;
    height: 34px;
    border-radius: var(--radius-md);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
    color: var(--accent);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--dur-fast) var(--ease-standard);
    -webkit-tap-highlight-color: transparent;
  }
  .icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
  }
  .icon-btn:active:not(:disabled) {
    transform: scale(0.94);
  }
  .icon-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* ── 对话列表（角色 → 多条对话）── */
  .conv-list {
    border-radius: var(--radius-2xl);
    padding: var(--gap-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 46vh;
    overflow-y: auto;
    flex-shrink: 0;
    animation: convIn var(--dur-fast) var(--ease-standard);
  }
  @keyframes convIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  .conv-head {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: 6px var(--gap-md) 8px;
    border-bottom: 1px solid var(--neutral-2);
    margin-bottom: 4px;
  }
  .conv-title {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-muted);
  }
  .conv-n {
    margin-left: auto;
    font-size: 0.66rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .conv-empty {
    margin: 0;
    padding: 14px var(--gap-md);
    font-size: 0.74rem;
    color: var(--text-faint);
    text-align: center;
  }
  .conv-row {
    display: flex;
    align-items: stretch;
    gap: 2px;
    border-radius: var(--radius-lg);
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .conv-row:hover {
    background: var(--neutral-1);
  }
  .conv-row.active {
    background: var(--accent-soft);
  }
  .conv-pick {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 9px var(--gap-md);
    border: none;
    background: transparent;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }
  .conv-name {
    max-width: 100%;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conv-row.active .conv-name {
    color: var(--accent);
  }
  .conv-meta {
    font-size: 0.64rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .conv-del {
    width: 32px;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: var(--radius-md);
    display: grid;
    place-items: center;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .conv-del svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
  }
  .conv-del:hover {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .conv-new {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    margin-top: 4px;
    padding: 9px;
    border-radius: var(--radius-lg);
    border: 1px dashed var(--neutral-4);
    background: transparent;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .conv-new svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
  }
  .conv-new:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }
  .conv-new:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* 切换角色：进入独立角色页 */
  .switch-char {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 12px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: all var(--dur-fast) var(--ease-standard);
    -webkit-tap-highlight-color: transparent;
  }
  .switch-char svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .switch-char:active {
    transform: scale(0.95);
  }

  /* 消息区 */
  .messages {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    padding: var(--gap-sm) 2px;
    min-height: 0;
    scroll-behavior: smooth;
  }

  /* 横屏族：气泡列让位给右侧立绘。
     宽度用「视口坐标」算，与 .art 的视口锚点同分母，故不会再重叠：
       可用宽 = 100vw − 立绘占位宽 − 外壳左内缩 − 8px(间隔)
     验算（真机横屏 1120×787）：1120 − min(1120, 0.667×787≈524.9) − 108 − 8 = 479.1
       → .messages 右缘 108+479.1 = 587.1 ≤ 立绘左缘 1120−524.9 = 595.1，安全。
     窄屏横屏（640×360）：--shell-left=12（无侧栏）→ 640 − 240 − 12 − 8 = 380 ≈ 59% 可用宽，仍充裕。 */
  @media (min-aspect-ratio: 1/1) {
    .messages {
      max-width: calc(100vw - var(--art-w) - var(--shell-left) - 8px);
    }
  }

  .empty {
    margin: auto;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-2xl) var(--gap-lg);
    max-width: 420px;
  }
  .empty-mark {
    width: 64px;
    height: 64px;
    border-radius: var(--radius-2xl);
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
    color: var(--on-accent);
    font-weight: 800;
    font-size: 1.6rem;
    box-shadow: 0 8px 32px var(--accent-glow);
    margin-bottom: var(--gap-sm);
  }
  .empty-mark.warn {
    background: var(--neutral-2);
    color: var(--text-muted);
    box-shadow: none;
  }
  .empty h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .empty p {
    margin: 0;
    font-size: 0.82rem;
  }
  .text-dim {
    color: var(--text-dim);
  }

  .spinner {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--neutral-3);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
    margin-bottom: var(--gap-sm);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* 思考中占位：模型先出 reasoning_content 时正文为空，此处给可见反馈 */
  .thinking {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 12px var(--gap-lg);
    border-radius: var(--radius-xl);
    background: var(--bubble-assistant-bg);
    border: 1px solid var(--bubble-assistant-border);
    backdrop-filter: blur(10px);
    align-self: flex-start;
    max-width: 78%;
  }
  .thinking .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.4;
    animation: thinkPulse 1.2s ease-in-out infinite;
  }
  .thinking .dot:nth-child(2) {
    animation-delay: 0.2s;
  }
  .thinking .dot:nth-child(3) {
    animation-delay: 0.4s;
  }
  .thinking-text {
    font-size: 0.74rem;
    color: var(--text-dim);
    margin-left: 2px;
  }
  @keyframes thinkPulse {
    0%,
    100% {
      opacity: 0.3;
      transform: translateY(0);
    }
    50% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }

  /* 输入区 */
  .composer {
    display: flex;
    align-items: flex-end;
    gap: var(--gap-sm);
    padding: var(--gap-sm);
    border-radius: var(--radius-2xl);
    flex-shrink: 0;
  }
  .composer-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: inherit;
    font-size: 0.92rem;
    line-height: 1.6;
    padding: 10px var(--gap-md);
    resize: none;
    outline: none;
    max-height: 140px;
    field-sizing: content;
  }
  .composer-input::placeholder {
    color: var(--text-faint);
  }
  .composer-input:disabled {
    opacity: 0.5;
  }

  /* 隐藏文件选择器（由图片按钮触发） */
  .file-input {
    display: none;
  }
  /* 图片按钮：与发送键同高，底部对齐；复用 .icon-btn 的观感 */
  .composer-img-btn {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
  }

  /* 待发送图片条：缩略图 + 提示，贴在输入区上方 */
  .img-strip {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    flex-wrap: wrap;
    padding: var(--gap-sm) var(--gap-md);
    border-radius: var(--radius-xl);
    flex-shrink: 0;
  }
  .img-thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .img-thumb {
    position: relative;
    line-height: 0;
  }
  .img-thumb img {
    display: block;
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: var(--radius-sm);
    border: 1px solid var(--neutral-3);
  }
  .img-remove {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: var(--danger);
    color: #fff;
    font-size: 0.8rem;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
    padding: 0;
  }
  .img-hint {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .send-btn {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .send-btn svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }
  .send-btn:hover:not(:disabled) {
    background: var(--accent-soft);
    filter: brightness(1.3);
  }
  .send-btn:active:not(:disabled) {
    transform: scale(0.94);
  }
  .send-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* 停止生成：与发送键同位置同尺寸，避免布局跳动 */
  .stop-btn {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--glass-border);
    background: var(--neutral-2);
    color: var(--text-muted);
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: all var(--dur-fast) var(--ease-standard);
  }
  .stop-btn svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  .stop-btn:active {
    transform: scale(0.94);
  }

  /* 错误提示：贴在输入区上方，可关闭 */
  .err {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: 10px var(--gap-md);
    border-radius: var(--radius-xl);
    border-color: color-mix(in srgb, var(--danger) 30%, transparent);
    flex-shrink: 0;
  }
  .err-text {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    color: var(--danger);
    line-height: 1.45;
    word-break: break-word;
  }
  .err-close {
    width: 24px;
    height: 24px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
  }

  /* 改写编辑框：贴在输入区上方 */
  .rewrite {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: var(--gap-md);
    border-radius: var(--radius-xl);
    flex-shrink: 0;
    animation: convIn var(--dur-fast) var(--ease-standard);
  }
  .rewrite-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .rewrite-title {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text-muted);
  }
  .rewrite-close {
    width: 24px;
    height: 24px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
  }
  .rewrite-input {
    width: 100%;
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-md);
    background: var(--input-bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
    line-height: 1.6;
    padding: 10px var(--gap-md);
    resize: vertical;
    outline: none;
    max-height: 32vh;
  }
  .rewrite-hint {
    margin: 0;
    font-size: 0.7rem;
    color: var(--text-faint);
  }
  .rewrite-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-sm);
  }
</style>
