import { test, expect, type Page } from '@playwright/test';

/**
 * 学习建议面板 E2E（self-learning-pipelines · Phase 3 壳层接线）。// [SSA-LEARN]
 *
 * 为什么还要这一层：G3 的 Node 门禁覆盖了 `gate-core.ts` 的全部判定逻辑，
 * 但**壳层接线**（flag → 入口显隐 → 按钮 → 渲染 → localStorage）在 Node 里
 * import 不了（`$state` 需编译）。此处补上这段，断言重点是**行为与副作用**：
 *
 *  1. 关 flag → 无「学习建议」入口（回滚 = 关开关，C-13）；
 *  2. 开 flag → 入口出现，面板可开；
 *  3. 「开始学习」→ 出建议列表 → 「采纳」→ 台账写入 localStorage，待办数下降；
 *  4. **学习过程零网络请求**（行为断言，非收益表述：本机计算不得触网；Phase 4 后专指
 *     **计算**阶段，落盘是用户点「采纳」的显式动作，见第 8 点）；
 *  5. **不改语料**：`tavern.sessions` 学习前后逐字节相同；不写 `tavern.groupSessions`（R9）；
 *  6. 面板**不暴露内核数值**（R-08：无 θ / theta / minFreq / window 字样）；
 *  7. 零建议时**不弹窗**（R-11）：内联文案，且全程无 dialog 事件；
 *  8. **Phase 4 落盘**（对着一个内存世界书桩跑）：未选目标书 → 只提示不写；
 *     选定后「采纳」→ 后端真收到条目（`position=1`、非 static、别人的条目原样保留）；
 *     「撤销」→ 后端真的移除；写失败 → 显性报错且本机记录不变（R8）。
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

/** 后端内存世界书（字段刻意宽松：这里只做搬运，语义由被测代码负责）。 */
interface WbEntry {
  uid?: number;
  key?: unknown;
  content?: unknown;
  comment?: unknown;
  position?: number;
  extensions?: Record<string, unknown>;
}
interface WbStub {
  books: Map<string, { entries: Record<string, WbEntry>; name: string }>;
  /** `/api/worldinfo/edit` 收到的请求（按顺序）——「学习不写书」靠它的长度断言 */
  edits: { name: string; data: { entries: Record<string, WbEntry>; name: string } }[];
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

/** 一本《测试书》+ 一条手工条目：用来证明落盘不碰别人的东西。 */
function stubWorldbook(): WbStub {
  const books: WbStub['books'] = new Map([
    [
      '测试书',
      {
        name: '测试书',
        entries: {
          '0': { uid: 0, key: ['旧词'], content: MANUAL_CONTENT, comment: '手工', position: 1 },
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
 * Phase 4 起 `stubBackend` 同时装世界书桩（内存书 + 写入记录）：`/worldinfo/edit`
 * 是真写盘动作的落点，必须是**有状态**的，否则「采纳到底写了什么」无从断言。
 * 现有用例不传 `wb` → 空书列表，行为与改动前一致。
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

async function seedSession(page: Page) {
  await page.addInitScript(
    ([list]) => localStorage.setItem('tavern.sessions', JSON.stringify(list)),
    [SESSIONS],
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

  test('开启后：学习 → 采纳（写进目标世界书）→ 台账落盘，且学习阶段零网络请求 / 不改语料', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);

    // 记录面板打开后发出的**全部**请求（学习必须是纯本机计算）
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));

    await page.goto('/');
    await openLearning(page);
    // Phase 4：采纳是落盘动作，先选目标书（否则只提示不写）
    await expect(page.getByLabel('选择目标世界书').locator('option')).toHaveCount(2);
    await page.getByLabel('选择目标世界书').selectOption('测试书');

    // 语料基线（学习必须只读）
    const before = await page.evaluate(() => localStorage.getItem('tavern.sessions'));

    requests.length = 0; // 只统计「开始学习」之后的请求
    await page.getByRole('button', { name: '开始学习' }).click();

    // 建议列表出现（夹具 2 轮 → 至少应产出模板行或耦合词对）
    await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });
    const pendingText = await page.getByText(/待确认 · \d+ 条/).innerText();
    const pending = Number(pendingText.match(/待确认 · (\d+) 条/)![1]);
    expect(pending).toBeGreaterThan(1);

    // 零网络请求（行为断言：计算阶段不触网）
    const external = requests.filter((u) => !u.startsWith('http://127.0.0.1:4173'));
    expect(external, `学习期间出现外部请求：${external.join(', ')}`).toHaveLength(0);
    // Phase 4：**计算阶段零写入**——写世界书只可能是用户点「采纳」（C-06 / R-02）
    expect(requests.filter((u) => u.includes('/api/worldinfo/edit'))).toHaveLength(0);

    // 采纳第一条 → 真写进世界书、待办数 -1、台账写入
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(new RegExp(`待确认 · ${pending - 1} 条`))).toBeVisible();
    expect(wb.learned('测试书'), '采纳必须真的落盘').toHaveLength(1);

    const ledgerRaw = await page.evaluate(() => localStorage.getItem('tavern.learning.ledger'));
    expect(ledgerRaw).not.toBeNull();
    const ledger = JSON.parse(ledgerRaw!);
    expect(ledger.v).toBe(1);
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.decisions[0].action).toBe('applied');
    expect(String(ledger.decisions[0].uid).length).toBeGreaterThan(0);
    expect(ledger.decisions[0].target.book).toBe('测试书');

    // 不改语料（R9/C-02：学习只读；群聊键一个字都没写）
    const after = await page.evaluate(() => localStorage.getItem('tavern.sessions'));
    expect(after).toBe(before);
    expect(await page.evaluate(() => localStorage.getItem('tavern.groupSessions'))).toBeNull();
  });

  test('拒绝与编辑：三种决定都进台账，编辑正文以编辑版为准，且写进世界书的是编辑版', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await page.goto('/');
    await openLearning(page);
    await expect(page.getByLabel('选择目标世界书').locator('option')).toHaveCount(2);
    await page.getByLabel('选择目标世界书').selectOption('测试书');
    await page.getByRole('button', { name: '开始学习' }).click();
    await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });

    // 拒绝第一条
    await rowWith(page, '拒绝').getByRole('button', { name: '拒绝', exact: true }).click();
    // 编辑（新的第一条）：进入编辑态后该行按钮变为「保存并采纳」，故按新按钮重新定位
    await rowWith(page, '编辑').getByRole('button', { name: '编辑', exact: true }).click();
    const editing = rowWith(page, '保存并采纳');
    await editing.locator('input.edit').fill('编辑后的模板正文（人工确认）');
    await editing.getByRole('button', { name: '保存并采纳' }).click();
    await expect(page.getByText(/已写入世界书《测试书》/)).toBeVisible();

    const ledger = JSON.parse((await page.evaluate(() => localStorage.getItem('tavern.learning.ledger')))!);
    const actions = ledger.decisions.map((d: { action: string }) => d.action);
    expect(actions).toContain('rejected');
    expect(actions).toContain('edited');
    expect(actions).not.toContain('applied');
    const edited = ledger.decisions.find((d: { action: string }) => d.action === 'edited');
    expect(edited.text).toBe('编辑后的模板正文（人工确认）');
    // 拒绝不落盘；编辑的那条落盘正文 = 编辑版（不是内核原文）
    const learned = wb.learned('测试书');
    expect(learned, '只应有编辑的那一条进世界书').toHaveLength(1);
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
    await page.goto('/');
    await openLearning(page);
    await page.getByRole('button', { name: '开始学习' }).click();
    await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });

    // 面板可见文本不得出现 θ / 内核参数名（数值面板 = 把雷交给用户）
    const text = await page.locator('main, .subpage').first().innerText();
    for (const banned of ['θ', 'theta', 'minFreq', 'min_freq', 'window', 'topN', '滑动窗口']) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  test('落盘：未选目标书只提示不写；选定后「采纳」真写进世界书，且不动别人的条目', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await page.goto('/');
    await openLearning(page);
    await page.getByRole('button', { name: '开始学习' }).click();
    await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });
    const pending = Number((await page.getByText(/待确认 · \d+ 条/).innerText()).match(/待确认 · (\d+) 条/)![1]);

    // 学完还没写任何东西（没点采纳 = 没落盘）
    expect(wb.edits, '学习本身不得写世界书').toHaveLength(0);

    // 未选目标书就采纳 → 显性提示，且不写后端、不记台账（R-11 / R8：不虚报成功）
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/请先选择（或新建）要写入的世界书/)).toBeVisible();
    expect(wb.edits).toHaveLength(0);
    expect(await readLedger(page), '未写入就不得记 applied').toBeNull();

    // 选定目标书（下拉来自 /api/worldinfo/list 桩）→ 采纳 → 后端真的收到
    await expect(page.getByLabel('选择目标世界书').locator('option')).toHaveCount(2); // （未选择）+ 测试书
    await page.getByLabel('选择目标世界书').selectOption('测试书');
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入世界书《测试书》/)).toBeVisible();
    await expect(page.getByText(/已写入世界书 · 1 条/)).toBeVisible();
    await expect(page.getByText(new RegExp(`待确认 · ${pending - 1} 条`))).toBeVisible();

    expect(wb.edits).toHaveLength(1);
    const learned = wb.learned('测试书');
    expect(learned, '后端应有且只有 1 条学习产物').toHaveLength(1);
    expect(learned[0].key, '触发词不得为空').not.toHaveLength(0);
    expect(String(learned[0].content).length, '正文不得为空').toBeGreaterThan(0);
    // R-07：落盘条目恒为后置（position 1）→ 永不进冻结前缀块；且绝不 static（骨架标志）
    expect(learned[0].position).toBe(1);
    expect(learned[0].extensions?.static).toBeUndefined();
    expect(String(learned[0].extensions?.learnedId)).toMatch(/^learned:/);
    // 别人的条目原样保留（只动自己那条）
    const manual = wb.manual('测试书');
    expect(manual).toHaveLength(1);
    expect(manual[0].content).toBe(MANUAL_CONTENT);

    // 台账记下 book + learnedId（撤销的依据）
    const ledger = await readLedger(page);
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.decisions[0].action).toBe('applied');
    expect(ledger.decisions[0].target.book).toBe('测试书');
    expect(ledger.decisions[0].target.learnedId).toBe(`learned:${ledger.decisions[0].uid}`);
  });

  test('撤销真的从世界书移除；写入失败时显性报错且本机记录不变', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await page.goto('/');
    await openLearning(page);
    await expect(page.getByLabel('选择目标世界书').locator('option')).toHaveCount(2);
    await page.getByLabel('选择目标世界书').selectOption('测试书');
    await page.getByRole('button', { name: '开始学习' }).click();
    await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });
    const pending = Number((await page.getByText(/待确认 · \d+ 条/).innerText()).match(/待确认 · (\d+) 条/)![1]);

    // ① 正常写入一条
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入世界书 · 1 条/)).toBeVisible();
    expect(wb.learned('测试书')).toHaveLength(1);

    // ② 写失败（edit 返回 500）：显性报错、后端未变、本机记录不变（R8）
    wb.failEdit = true;
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/写入世界书《测试书》失败/)).toBeVisible();
    await expect(page.getByText(/本机记录未变更/)).toBeVisible();
    expect(wb.learned('测试书'), '写失败不得改动后端').toHaveLength(1);
    const afterFail = await readLedger(page);
    expect(afterFail.decisions, '写失败不得多记一条').toHaveLength(1);
    await expect(page.getByText(new RegExp(`待确认 · ${pending - 1} 条`)), '失败的那条仍在待确认').toBeVisible();

    // ③ 撤销：真的从后端摘除，台账记 reverted；手工条目与其它条目不受影响
    wb.failEdit = false;
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByText(/已从《测试书》移除该条目/)).toBeVisible();
    expect(wb.learned('测试书')).toHaveLength(0);
    expect(wb.all('测试书'), '只剩原来那条手工条目').toHaveLength(1);
    expect(wb.manual('测试书')[0].content).toBe(MANUAL_CONTENT);
    await expect(page.getByText(/已写入世界书 · \d+ 条/)).toHaveCount(0);

    const ledger = await readLedger(page);
    expect(ledger.decisions.map((d: { action: string }) => d.action)).toEqual(['applied', 'reverted']);
    // reverted 不带 target（撤销的目标在它前面那条 applied 上），但 uid 必须一致
    expect(ledger.decisions[1].uid).toBe(ledger.decisions[0].uid);
    expect(ledger.decisions[1].target).toBeUndefined();
  });

  test('关 flag 不删已写入的条目（C-08），且提示里明说不会自动删除', async ({ page }) => {
    const wb = stubWorldbook();
    await stubBackend(page, wb);
    await seedSession(page);
    await page.goto('/');
    await openLearning(page);
    await expect(page.getByLabel('选择目标世界书').locator('option')).toHaveCount(2);
    await page.getByLabel('选择目标世界书').selectOption('测试书');
    await page.getByRole('button', { name: '开始学习' }).click();
    await expect(page.getByText(/待确认 · \d+ 条/)).toBeVisible({ timeout: 15000 });
    await rowWith(page, '采纳').getByRole('button', { name: '采纳', exact: true }).click();
    await expect(page.getByText(/已写入世界书 · 1 条/)).toBeVisible();
    const writesAfterApply = wb.edits.length;

    // 用户可见的承诺（页面自己的话，不是台账内部语义）
    await expect(page.getByText(/关掉学习开关不会删除已写入的条目/)).toBeVisible();

    // 关掉学习开关：入口消失，但**不产生任何写入/删除请求**，后端条目仍在
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByRole('switch', { name: '启用学习' }).click();
    await expect(page.getByRole('button', { name: /学习建议/ })).toHaveCount(0);
    expect(wb.edits.length, '关 flag 不得产生任何写入').toBe(writesAfterApply);
    expect(wb.learned('测试书'), '关 flag 不得删除已写入的条目').toHaveLength(1);

    // 再开回来：已写入的条目仍在（关 flag 不是「复原」，只是隐藏入口）
    await openLearning(page);
    await expect(page.getByText(/已写入世界书 · 1 条/)).toBeVisible();
    await expect(page.getByText(/关开关不会自动删除/)).toBeVisible();
  });
});
