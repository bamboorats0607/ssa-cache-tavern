import { test, expect, type Page } from '@playwright/test';

/**
 * 学习建议面板 E2E（self-learning-pipelines · Phase 3 壳层接线 + 副本沙盒）。// [SSA-LEARN]
 *
 * 为什么还要这一层：G3/G4′ 的 Node 门禁覆盖了 `gate-core.ts` / `copy-core.ts` 的判定逻辑，
 * 但**壳层接线**（flag → 入口显隐 → 按钮 → 渲染 → localStorage → 后端请求）在 Node 里
 * import 不了（`$state` 需编译）。此处补上这段，断言重点是**行为与副作用**：
 *
 *  1. 关 flag → 无「学习建议」入口（回滚 = 关开关，C-13）；
 *  2. 开 flag → 入口出现，面板可开；
 *  3. 「开始学习」→ 出建议列表 → 「采纳」→ 台账写入 localStorage，待办数下降；
 *  4. **学习（计算）过程零网络请求**（本机计算不得触网）；写副本是点「采纳」的显式动作；
 *  5. **不改语料**：`tavern.sessions` 学习前后逐字节相同；不写 `tavern.groupSessions`（R9）；
 *  6. 面板**不暴露内核数值**（R-08：无 θ / theta / minFreq / window 字样）；
 *  7. 零建议时**不弹窗**（R-11）：内联文案，且全程无 dialog 事件；
 *  8. **副本沙盒**（spec §10）：
 *     · 没有副本时「采纳」被拒（禁止向非副本提交）；
 *     · 「创建并启用副本」把**当前启用的**世界书原样克隆，并把副本设为启用书；
 *     · 采纳只写副本 —— **源书逐字节不变**（含 App 未建模的字段）；
 *     · 副本不是启用书时拒写；写失败显性报错且本机记录不变（R8）；
 *     · 「撤销」与「整体回滚」只摘副本里的学习条目，用户手写的条目一字不动。
 */

/**
 * 单角色会话夹具（角色名 2 字汉字 → 人名通道可用）。
 *
 * 刻意做成**词表高度重复**的多轮语料：四通道的 `minFreq=5` 是上游按 100K 消息
 * 调的值，几轮对话根本过不了门槛（实测 4 条消息只产出 1 条名归一化建议）。
 * 这里 6 会话 × 12 轮 = 144 条消息，保证候选簇 / 模板行 / 耦合词对都能出。
 */
const VOCAB = ['钟楼', '银线', '星髓', '黑市', '议会宫', '雾主', '渡口', '守夜人'];

function makeSessions(count: number, turnsPer: number) {
  const out = [];
  for (let s = 0; s < count; s++) {
    const turns = [];
    for (let i = 0; i < turnsPer; i++) {
      const a = VOCAB[(i + s) % VOCAB.length];
      const b = VOCAB[(i + s + 1) % VOCAB.length];
      turns.push({
        id: `t-${s}-${i}`,
        round: i + 1,
        at: 1700000000000 + (s * turnsPer + i) * 1000,
        userText: `${a}那边的消息传来了，${b}的事恐怕和守夜人脱不了干系，我们得去${a}看看。`,
        assistantText: `艾拉沉默片刻：「${a}与${b}，这两件事本就相连。」`,
        stats: { inputTokens: 100, outputTokens: 50, cachedTokens: 64, inputMeasured: true, breakdown: { prefix: 0, suffix: 0, liveClusters: 0, facts: 0, leaf: 0 } },
        durationMs: 800,
        model: 'm',
      });
    }
    out.push({
      v: 1,
      id: `sess-learn-${s}`,
      title: `银线之夜 ${s + 1}`,
      renamed: false,
      characterName: '艾拉',
      createdAt: 1700000000000 + s * 100000,
      updatedAt: 1700000000000 + s * 100000 + turnsPer * 1000,
      turns,
    });
  }
  return out;
}

const SESSIONS = makeSessions(6, 12);

/** 建议行定位：`.row` 里带指定按钮的那一行（语料组也有 `.row`，必须按按钮筛）。 */
const rowWith = (page: Page, action: string) =>
  page.locator('.row').filter({ has: page.getByRole('button', { name: action, exact: true }) }).first();

/** 源书名（种子）。 */
const SOURCE = '测试书';

/** 后端内存世界书（字段刻意宽松：这里只做搬运，语义由被测代码负责）。 */
interface WbEntry {
  uid?: number;
  key?: unknown;
  content?: unknown;
  comment?: unknown;
  position?: number;
  /** 上游字段：App 未建模 —— 用来证明「写入不改原书字节」 */
  selectiveLogic?: number;
  matchWholeWords?: boolean;
  sticky?: number;
  group?: string;
  extensions?: Record<string, unknown>;
}
interface WbBook {
  entries: Record<string, WbEntry>;
  name: string;
}
interface WbStub {
  books: Map<string, WbBook>;
  /** `/api/worldinfo/edit` 收到的请求（按顺序）——「学习不写书」靠它的长度断言 */
  edits: { name: string; data: WbBook }[];
  /** 置 true 后 edit 端点返回 500（失败路径） */
  failEdit: boolean;
  /** 某本书的全部条目 */
  all(name: string): WbEntry[];
  /** 带学习标记（`extensions.learnedId`）的条目 */
  learned(name: string): WbEntry[];
  /** 手工条目（无学习标记） */
  manual(name: string): WbEntry[];
}

const MANUAL_CONTENT = '手工写的条目（不该被动）';

/** 一本《测试书》+ 一条「带全部上游字段」的手工条目：证明写副本不碰源书。 */
function stubWorldbook(): WbStub {
  const books: WbStub['books'] = new Map([
    [
      SOURCE,
      {
        name: SOURCE,
        entries: {
          '0': {
            uid: 0,
            key: ['旧词'],
            content: MANUAL_CONTENT,
            comment: '手工',
            position: 1,
            selectiveLogic: 0,
            matchWholeWords: true,
            sticky: 2,
            group: 'g1',
          },
        },
      },
    ],
  ]);
  const edits: WbStub['edits'] = [];
  const all = (name: string) => Object.values(books.get(name)?.entries ?? {});
  return {
    books,
    edits,
    failEdit: false,
    all,
    learned: (name) => all(name).filter((e) => typeof e.extensions?.learnedId === 'string'),
    manual: (name) => all(name).filter((e) => typeof e.extensions?.learnedId !== 'string'),
  };
}

/**
 * 只做「不联网也打得开设置页」所需的最小后端桩。
 *
 * `stubBackend` 同时装世界书桩（内存书 + 写入记录）：`/worldinfo/edit` 是
 * 真写盘动作的落点，必须是**有状态**的，否则「采纳到底写了什么」无从断言。
 */
async function stubBackend(page: Page, wb: WbStub = stubWorldbook()) {
  await page.addInitScript(() => {
    localStorage.setItem('tavern.backendUrl', location.origin);
    localStorage.setItem('tavern.backendEverReady', '1');
  });
  await page.route('**/tavern/health', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'fallback' }) }),
  );
  await page.route('**/api/characters/all', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/worldinfo/list', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([...wb.books.keys()].map((n) => ({ file_id: n, name: n, extensions: {} }))),
    }),
  );
  await page.route('**/api/worldinfo/get', (r) => {
    const name = String(JSON.parse(r.request().postData() || '{}').name ?? '');
    const book = wb.books.get(name);
    if (!book) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(book) });
  });
  await page.route('**/api/worldinfo/edit', (r) => {
    if (wb.failEdit) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    const body = JSON.parse(r.request().postData() || '{}') as WbStub['edits'][number];
    wb.edits.push(body);
    wb.books.set(body.name, body.data);
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/csrf-token', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'disabled' }) }),
  );
}

/** 读台账（未写过时返回 null，用于断言「什么都没记」）。 */
async function readLedger(page: Page) {
  const raw = await page.evaluate(() => localStorage.getItem('tavern.learning.ledger'));
  return raw === null ? null : JSON.parse(raw);
}

/** 读沙盒记录（未创建副本时返回 null）。 */
async function readSandbox(page: Page) {
  const raw = await page.evaluate(() => localStorage.getItem('tavern.learning.sandbox'));
  return raw === null ? null : JSON.parse(raw);
}

async function seedSession(page: Page) {
  await page.addInitScript(
    ([list]) => localStorage.setItem('tavern.sessions', JSON.stringify(list)),
    [SESSIONS],
  );
}

/** 让 App 启动时就认为「《测试书》已启用」（等价于用户在世界书页选过它）。 */
async function seedActiveBook(page: Page, name: string | null = SOURCE) {
  await page.addInitScript(
    ([n]) => localStorage.setItem('tavern.worldbook', JSON.stringify({ activeName: n })),
    [name],
  );
}

async function openLearning(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).first().click();
  const sw = page.getByRole('switch', { name: '启用学习' });
  await expect(sw).toBeVisible();
  if ((await sw.getAttribute('aria-checked')) !== 'true') {
    await sw.click();
  }
  await page.getByRole('button', { name: /学习建议/ }).click();
  await expect(page.locator('h1')).toHaveText('学习建议');
}

/** 进面板并学一轮，返回建议条数。 */
async function learnOnce(page: Page): Promise<number> {
  await page.getByRole('button', { name: '开始学习' }).click();
  await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });
  const t = await page.getByText(/待确认 · \d+ 条/).innerText();
  return Number(t.match(/待确认 · (\d+) 条/)![1]);
}

/** 创建并启用副本，返回副本名（从沙盒记录读，避免猜时间戳）。 */
async function createCopy(page: Page): Promise<string> {
  await page.getByRole('button', { name: '创建并启用副本' }).click();
  await expect(page.getByText(/已创建并启用学习副本《/)).toBeVisible({ timeout: 10000 });
  const sb = await readSandbox(page);
  expect(sb, '沙盒记录必须落盘（否则刷新就丢副本溯源）').not.toBeNull();
  expect(sb.copyName).toMatch(/·学习副本@/);
  expect(sb.sourceName).toBe(SOURCE);
  return sb.copyName as string;
}

test.describe('学习建议面板', () => {
  test('关闭 flag：开关在，但无「学习建议」入口', async ({ page }) => {
    await stubBackend(page);
    await seedSession(page);
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).first().click();

    const sw = page.getByRole('switch', { name: '启用学习' });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    // C-13 回滚语义：关 flag → 能力入口不存在
    await expect(page.getByRole('button', { name: /学习建议/ })).toHaveCount(0);
    // 默认关时不得写入任何学习键
    expect(await page.evaluate(() => localStorage.getItem('tavern.learning.enabled'))).toBeNull();
  });

  test('没有副本时「采纳」被拒：禁止向非副本提交（不写后端、不记台账）', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    await learnOnce(page);

    // 面板给的是「创建并启用副本」，不再有「写入目标」下拉
    await expect(page.getByLabel('选择目标世界书')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '创建并启用副本' })).toBeVisible();
    expect(wb.edits, '学习本身不得写世界书').toHaveLength(0);

    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/学习产物只能写进副本/)).toBeVisible();
    expect(wb.edits, '被拒时不得写后端').toHaveLength(0);
    expect(await readLedger(page), '未写入就不得记 applied').toBeNull();
    expect(await readSandbox(page)).toBeNull();
  });

  test('创建副本：克隆当前启用的书（源书不改），采纳只写副本且源书逐字节不变', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));

    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);

    // 副本 = 源书原样克隆（含 App 未建模的字段），源书本身没被动
    expect(wb.books.has(copyName), '副本必须真写进后端').toBe(true);
    const srcBefore = JSON.stringify(wb.books.get(SOURCE));
    const copyEntry = wb.books.get(copyName).entries['0'];
    expect(copyEntry.content).toBe(MANUAL_CONTENT);
    expect(copyEntry.selectiveLogic, '上游字段必须随克隆保留').toBe(0);
    expect(copyEntry.matchWholeWords).toBe(true);
    expect(copyEntry.group).toBe('g1');

    // 启用书已切到副本（成功后才切：安全激活 P3）
    expect(await readSandbox(page)).not.toBeNull();

    // 语料基线（学习必须只读）
    const before = await page.evaluate(() => localStorage.getItem('tavern.sessions'));

    requests.length = 0; // 只统计「开始学习」之后的请求
    const pending = await learnOnce(page);
    expect(pending).toBeGreaterThan(1);

    // 零网络请求（行为断言：计算阶段不触网）
    const external = requests.filter((u) => !u.startsWith('http://127.0.0.1:4173'));
    expect(external, `学习期间出现外部请求：${external.join(', ')}`).toHaveLength(0);
    expect(requests.filter((u) => u.includes('/api/worldinfo/edit'))).toHaveLength(0);

    // 采纳 → 写进**副本**、待办 -1、台账记下副本名
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(new RegExp(`已写入副本《${copyName}》`))).toBeVisible();
    await expect(page.getByText(new RegExp(`待确认 · ${pending - 1} 条`))).toBeVisible();
    const learned = wb.learned(copyName);
    expect(learned, '采纳必须真的落进副本').toHaveLength(1);
    // R-07：落盘条目恒为后置（position 1）；且绝不 static（骨架标志）
    expect(learned[0].position).toBe(1);
    expect(learned[0].extensions?.static).toBeUndefined();
    expect(String(learned[0].extensions?.learnedId)).toMatch(/^learned:/);

    // ★ 源书逐字节不变（含上游字段）——「原书不进写入路径」的硬断言
    expect(JSON.stringify(wb.books.get(SOURCE)), '源书必须逐字节不变').toBe(srcBefore);
    expect(wb.manual(SOURCE)).toHaveLength(1);
    expect(wb.learned(SOURCE), '源书里绝不该有学习产物').toHaveLength(0);
    // 副本自身的手工条目也在
    expect(wb.manual(copyName)).toHaveLength(1);

    const ledger = await readLedger(page);
    expect(ledger.v).toBe(1);
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.decisions[0].action).toBe('applied');
    expect(ledger.decisions[0].target.book).toBe(copyName);
    expect(String(ledger.decisions[0].target.learnedId)).toMatch(/^learned:/);

    // 不改语料（R9/C-02：学习只读；群聊键一个字都没写）
    const after = await page.evaluate(() => localStorage.getItem('tavern.sessions'));
    expect(after).toBe(before);
    expect(await page.evaluate(() => localStorage.getItem('tavern.groupSessions'))).toBeNull();
  });

  test('副本不是启用书时拒写；切回源书后再采纳仍被拒（不写任何书）', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);
    await learnOnce(page);

    // 切回源书 → 副本不再是启用书
    await page.getByRole('button', { name: '切回源书' }).click();
    await expect(page.getByText(new RegExp(`已切回源书《${SOURCE}》`))).toBeVisible();
    await expect(page.getByText(/副本不是当前启用的世界书/)).toBeVisible();

    const editsBefore = wb.edits.length;
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/当前不是启用的世界书/)).toBeVisible();
    expect(wb.edits.length, '拒写时不得发任何写入请求').toBe(editsBefore);
    expect(wb.learned(copyName), '拒写时副本不得变').toHaveLength(0);
    expect(await readLedger(page), '拒写不得记 applied').toBeNull();

    // 启用副本 → 这次能写
    await page.getByRole('button', { name: '启用副本' }).click();
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(new RegExp(`已写入副本《${copyName}》`))).toBeVisible();
    expect(wb.learned(copyName)).toHaveLength(1);
  });

  test('拒绝与编辑：三种决定都进台账，写进副本的是编辑版', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);
    await learnOnce(page);

    // 拒绝第一条
    await rowWith(page, '拒绝').getByRole('button', { name: '拒绝', exact: true }).click();
    // 编辑（新的第一条）：进入编辑态后该行按钮变为「保存并采纳」，故按新按钮重新定位
    await rowWith(page, '编辑').getByRole('button', { name: '编辑', exact: true }).click();
    const editing = rowWith(page, '保存并采纳');
    await editing.locator('input.edit').fill('编辑后的模板正文（人工确认）');
    await editing.getByRole('button', { name: '保存并采纳' }).click();
    await expect(page.getByText(new RegExp(`已写入副本《${copyName}》`))).toBeVisible();

    const ledger = await readLedger(page);
    const actions = ledger.decisions.map((d: { action: string }) => d.action);
    expect(actions).toContain('rejected');
    expect(actions).toContain('edited');
    expect(actions).not.toContain('applied');
    const edited = ledger.decisions.find((d: { action: string }) => d.action === 'edited');
    expect(edited.text).toBe('编辑后的模板正文（人工确认）');
    // 拒绝不落盘；编辑的那条落盘正文 = 编辑版（不是内核原文）
    const learned = wb.learned(copyName);
    expect(learned, '只应有编辑的那一条进副本').toHaveLength(1);
    expect(learned[0].content).toBe('编辑后的模板正文（人工确认）');
  });

  test('零建议：内联空态文案，全程不弹窗', async ({ page }) => {
    await stubBackend(page);
    // 不播种会话 → 语料为空 → 零建议
    await page.goto('/');

    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await openLearning(page);
    await page.getByRole('button', { name: '开始学习' }).click();
    await expect(page.getByText(/没有学到可用的建议/)).toBeVisible({ timeout: 15000 });
    expect(dialogs, `不应弹窗：${dialogs.join(' / ')}`).toHaveLength(0);
  });

  test('面板不暴露内核数值（R-08）', async ({ page }) => {
    await stubBackend(page);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    await createCopy(page);
    await learnOnce(page);

    // 面板可见文本不得出现 θ / 内核参数名（数值面板 = 把雷交给用户）
    const text = await page.locator('main, .subpage').first().innerText();
    for (const banned of ['θ', 'theta', 'minFreq', 'min_freq', 'window', 'topN', '滑动窗口']) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  test('配额与增量视图：面板给出余量与相对克隆快照的增量数字', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);

    // 克隆刚完成：配额空、增量全 0
    await expect(page.getByText(/候选簇 0\/40 · 模板行 0\/40/)).toBeVisible();
    await expect(page.getByText(/学习追加 0 · 你手增 0 · 手改 0 · 删除 0/)).toBeVisible();

    await learnOnce(page);
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(new RegExp(`已写入副本《${copyName}》`))).toBeVisible();
    // 采纳一条 → 增量视图的「学习追加」+1（可观测项，spec §10）
    await expect(page.getByText(/学习追加 1 · /)).toBeVisible();
    await expect(page.getByText(/副本里的学习条目/)).toBeVisible();
  });

  test('撤销只摘副本里的那一条；整体回滚摘掉全部学习条目，用户手写的条目不动', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);
    const srcBefore = JSON.stringify(wb.books.get(SOURCE));
    await learnOnce(page);

    // ① 写两条
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入副本 · 1 条/)).toBeVisible();
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入副本 · 2 条/)).toBeVisible();
    expect(wb.learned(copyName)).toHaveLength(2);
    expect(wb.manual(copyName)).toHaveLength(1);

    // ② 撤销：真的从副本摘除那一条，另一条不动
    await page.getByRole('button', { name: '撤销', exact: true }).first().click();
    await expect(page.getByText(new RegExp(`已从《${copyName}》移除`))).toBeVisible();
    expect(wb.learned(copyName)).toHaveLength(1);
    expect(wb.manual(copyName)[0].content).toBe(MANUAL_CONTENT);

    // ③ 整体回滚：学习条目清空，手工条目与源书都不动
    await page.getByRole('button', { name: '整体回滚' }).click();
    await expect(page.getByText(new RegExp(`已整体回滚：从副本《${copyName}》摘除 1 条`))).toBeVisible();
    expect(wb.learned(copyName)).toHaveLength(0);
    expect(wb.all(copyName), '只剩手工条目').toHaveLength(1);
    expect(wb.manual(copyName)[0].content).toBe(MANUAL_CONTENT);
    expect(JSON.stringify(wb.books.get(SOURCE)), '源书自始至终未变').toBe(srcBefore);
    // 增量视图回到 0
    await expect(page.getByText(/学习追加 0 · /)).toBeVisible();

    const ledger = await readLedger(page);
    // 台账口径：前两条是采纳；整体回滚给**每个受影响 uid** 记一条 reverted
    // （已经撤销过的那条会再记一次 —— 幂等、无害，这里断言「所有采纳过的 uid 都已被标回滚」）
    const actions = ledger.decisions.map((d: { action: string }) => d.action);
    expect(actions.slice(0, 2)).toEqual(['applied', 'applied']);
    expect(actions.slice(2).every((a: string) => a === 'reverted')).toBe(true);
    const revertedUids = new Set(
      ledger.decisions.filter((d: { action: string }) => d.action === 'reverted').map((d: { uid: string }) => d.uid),
    );
    for (const d of ledger.decisions.filter((x: { action: string }) => x.action === 'applied')) {
      expect(revertedUids.has(d.uid), `采纳过的 ${d.uid} 必须被标为已回滚`).toBe(true);
    }
  });

  test('写入失败：显性报错且本机记录不变（R8）', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);
    const pending = await learnOnce(page);

    // ① 正常写入一条
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入副本 · 1 条/)).toBeVisible();
    expect(wb.learned(copyName)).toHaveLength(1);

    // ② 写失败（edit 返回 500）：显性报错、后端未变、本机记录不变
    wb.failEdit = true;
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/写入副本失败/)).toBeVisible();
    await expect(page.getByText(/本机记录未变更/)).toBeVisible();
    expect(wb.learned(copyName), '写失败不得改动后端').toHaveLength(1);
    const afterFail = await readLedger(page);
    expect(afterFail.decisions, '写失败不得多记一条').toHaveLength(1);
    await expect(page.getByText(new RegExp(`待确认 · ${pending - 1} 条`)), '失败的那条仍在待确认').toBeVisible();
  });

  test('关 flag 不删副本里的条目（C-08），且提示里明说不会自动删除', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await seedActiveBook(page);
    await page.goto('/');
    await openLearning(page);
    const copyName = await createCopy(page);
    await learnOnce(page);
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入副本 · 1 条/)).toBeVisible();
    const writesAfterApply = wb.edits.length;

    // 用户可见的承诺（页面自己的话，不是台账内部语义）
    await expect(page.getByText(/关掉学习开关不会删除副本里的条目/)).toBeVisible();

    // 关掉学习开关：入口消失，但**不产生任何写入/删除请求**，副本条目仍在
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('switch', { name: '启用学习' }).click();
    await expect(page.getByRole('button', { name: /学习建议/ })).toHaveCount(0);
    expect(wb.edits.length, '关 flag 不得产生任何写入').toBe(writesAfterApply);
    expect(wb.learned(copyName), '关 flag 不得删除副本里的条目').toHaveLength(1);

    // 再开回来：副本记录与条目仍在（关 flag 不是「复原」，只是隐藏入口）
    await openLearning(page);
    await expect(page.getByText(new RegExp(`源书《${SOURCE}》· 克隆基线`))).toBeVisible();
    await expect(page.getByText(/已写入副本 · 1 条/)).toBeVisible();
  });

  test('没有启用任何世界书时：创建副本按钮禁用并说明原因（不静默失败）', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    // 刻意不播种启用书
    await page.goto('/');
    await openLearning(page);

    const btn = page.getByRole('button', { name: '创建并启用副本' });
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(page.getByText(/当前没有启用的世界书/)).toBeVisible();
    expect(await readSandbox(page)).toBeNull();
  });

  test('副本被删（僵尸副本）：启动时安全切回源书并显性说明（P3）', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    // 模拟「副本已被删除，但本机还记着它」：activeName=不存在的副本，sourceName=测试书
    await page.addInitScript(
      ([src]) =>
        localStorage.setItem(
          'tavern.worldbook',
          JSON.stringify({ activeName: '测试书·学习副本@2026-01-01 0000', sourceName: src }),
        ),
      [SOURCE],
    );
    await page.goto('/');
    await openLearning(page);

    // 安全激活：切回源书，且**不是**静默（页面给出说明）
    await expect(page.getByText(/已安全切回源书《测试书》/)).toBeVisible({ timeout: 10000 });
    expect(await readSandbox(page), '沙盒记录此时本就不该存在').toBeNull();
    // 源书仍可正常被克隆（说明切回后状态可用）
    await expect(page.getByRole('button', { name: '创建并启用副本' })).toBeEnabled();
  });
});
