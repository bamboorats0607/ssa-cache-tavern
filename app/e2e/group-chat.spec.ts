import { test, expect, type Page } from '@playwright/test';

/**
 * 群聊（group-chat）UI 回归测试 —— spec T2.4。
 *
 * 断言重点是**请求形状**与**存储隔离**，而不是「点了没报错」：
 *  1. 关闭 flag → 无群入口（单角色路径不受影响）；
 *  2. 开启 flag → 角色页多选成员开聊 → 聊天页出现群顶栏与成员条；
 *  3. 发送时：**群常量头**出现在第一条 system，且**只含成员姓名名单**
 *     （不含 `角色设定：`/`description` 等长文本，spec R1/C-05）；
 *  4. 记录只进 `tavern.groupSessions`，**不写** `tavern.sessions`（R9/C-02）；
 *  5. 记录字节**不含** `data:image/`（R3/C-03，群聊禁图）；
 *  6. 两条助手气泡的头像**互异**（R13：禁止复用同一头像）。
 */

const CHAR_A = '测试角色A';
const CHAR_B = '测试角色B';
const AVATAR_A = 'test-a.png';
const AVATAR_B = 'test-b.png';

const svg = (hex: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${hex}"/></svg>`;

/** 捕获生成请求体 + 交错的固定回复，便于逐轮断言。 */
async function stubBackend(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('tavern.backendUrl', location.origin);
    localStorage.setItem('tavern.backendEverReady', '1');
  });
  await page.route('**/tavern/health', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'fallback' }) }),
  );
  await page.route('**/api/characters/all', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { name: CHAR_A, avatar: AVATAR_A, description: 'A 的设定文本' },
        { name: CHAR_B, avatar: AVATAR_B, description: 'B 的设定文本' },
      ]),
    }),
  );
  await page.route('**/api/characters/get', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route(`**/characters/${AVATAR_A}`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg('#ff0000') }),
  );
  await page.route(`**/characters/${AVATAR_B}`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg('#00ff00') }),
  );
  await page.route('**/api/worldinfo/list', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/csrf-token', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'disabled' }) }),
  );

  const bodies: Record<string, unknown>[] = [];
  let n = 0;
  await page.route('**/api/backends/chat-completions/generate', async (r) => {
    bodies.push(JSON.parse(r.request().postData() ?? '{}'));
    n++;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: `第 ${n} 条群回复` } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 512 } },
      }),
    });
  });
  return bodies;
}

/** 用 localStorage 打开 flag（等价于设置页开关，测试里更快更稳）。 */
async function enableGroupFlag(page: Page) {
  await page.evaluate(() => localStorage.setItem('tavern.group.enabled', '1'));
  await page.reload();
  await page.waitForTimeout(600);
}

test.describe('群聊', () => {
  test('关闭 flag：设置可见开关，但角色页无群入口', async ({ page }) => {
    await stubBackend(page);
    await page.goto('/');

    // 设置页：群聊（实验）分组与开关都在
    await page.getByRole('button', { name: '设置', exact: true }).first().click();
    const sw = page.getByRole('switch', { name: '启用群聊' });
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'false');

    // 角色页：没有群聊入口（flag 关）
    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await expect(page.locator('h1')).toHaveText('角色');
    await expect(page.getByRole('button', { name: '群聊', exact: true })).toHaveCount(0);
  });

  test('设置页开关可切换 flag', async ({ page }) => {
    await stubBackend(page);
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).first().click();
    const sw = page.getByRole('switch', { name: '启用群聊' });
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('tavern.group.enabled'))).toBe('1');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => localStorage.getItem('tavern.group.enabled'))).toBeNull();
  });

  test('多选成员开聊：群顶栏 + 成员条 + 请求形状 + 存储隔离 + 头像互异', async ({ page }) => {
    const bodies = await stubBackend(page);
    await page.goto('/');
    await enableGroupFlag(page);

    // 1) 角色页 → 群聊（进入多选）→ 选两人 → 开始群聊
    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await page.getByRole('button', { name: '群聊', exact: true }).click();
    // 操作条必须**在视口内**才算可见：只见 boundingBox 而不在视口的元素，
    // 真机上既看不见也点不到（此断言用于拦住「被 flex 列表挤出可视区」这类回归）
    const bar = page.locator('.group-bar');
    await expect(bar).toBeVisible();
    const barBox = await bar.boundingBox();
    const vp = page.viewportSize()!;
    expect(barBox).not.toBeNull();
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(vp.height + 1);
    expect(barBox!.y).toBeGreaterThanOrEqual(0);
    await expect(page.getByText(/已选 0 人/)).toBeVisible();
    // 未满 2 人时不可开始
    await expect(page.getByRole('button', { name: '开始群聊' })).toBeDisabled();
    await page.locator('button.pick', { hasText: CHAR_A }).click();
    await page.locator('button.pick', { hasText: CHAR_B }).click();
    await expect(page.getByText(/已选 2 人/)).toBeVisible();
    await page.getByRole('button', { name: '开始群聊' }).click();

    // 2) 到聊天页：群顶栏 + 成员条（2 人）
    const memberBar = page.locator('[role="toolbar"][aria-label="群成员"]');
    await expect(memberBar).toBeVisible();
    await expect(memberBar.locator('button.member')).toHaveCount(2);

    // 3) 发第一条
    const input = page.getByPlaceholder(/说点什么/);
    await input.fill('大家晚上好');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByText('第 1 条群回复')).toBeVisible({ timeout: 10000 });

    // 4) 请求形状：首块是群常量头，只含姓名名单（R1/C-05）
    expect(bodies.length).toBe(1);
    const msgs = bodies[0].messages as { role: string; content: string }[];
    const head = String(msgs[0].content);
    expect(head.startsWith('【群聊】')).toBe(true);
    expect(head).toContain(CHAR_A);
    expect(head).toContain(CHAR_B);
    for (const banned of ['角色设定：', 'personality', 'scenario', 'mes_example', 'description']) {
      expect(head).not.toContain(banned);
    }
    // 发言人的角色块应存在于群常量头之后（可变区）
    const speakerCardIdx = msgs.findIndex((m) => String(m.content).startsWith('你正在扮演「'));
    expect(speakerCardIdx).toBeGreaterThan(0);

    // 5) 发第二条（本地状态机会换人：轮空补偿 + 连说惩罚）
    await input.fill('那谁来说说');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByText('第 2 条群回复')).toBeVisible({ timeout: 10000 });
    expect(bodies.length).toBe(2);

    // 6) R13：两条助手气泡头像互异
    const assistantAvatars = await page
      .locator('.msg-wrapper img.avatar-img')
      .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).getAttribute('src') ?? ''));
    const uniq = [...new Set(assistantAvatars)];
    expect(assistantAvatars.length).toBeGreaterThanOrEqual(2);
    expect(uniq.length).toBeGreaterThanOrEqual(2);
    expect(uniq.some((s) => s.includes('test-a.png'))).toBe(true);
    expect(uniq.some((s) => s.includes('test-b.png'))).toBe(true);

    // 7) 存储隔离 + 禁图（R9/C-02、R3/C-03）
    const store = await page.evaluate(() => ({
      groupSessions: localStorage.getItem('tavern.groupSessions'),
      sessions: localStorage.getItem('tavern.sessions'),
      groups: localStorage.getItem('tavern.groups'),
    }));
    expect(store.groups).toBeTruthy();
    expect(store.groupSessions).toBeTruthy();
    // 群聊绝不写单角色会话键
    expect(store.sessions).toBeNull();
    // 群记录禁带内联图片
    expect(store.groupSessions!.includes('data:image/')).toBe(false);
    const recs = JSON.parse(store.groupSessions!);
    expect(recs.length).toBe(1);
    expect(recs[0].turns.length).toBe(2);
    expect(recs[0].turns[0].replies.length).toBe(1);
    // 发言人键落在成员集合内（头像文件名命名空间）
    const speakers = recs[0].turns.map((t: { replies: { speakerKey: string }[] }) => t.replies[0].speakerKey);
    expect(speakers.every((k: string) => k === AVATAR_A || k === AVATAR_B)).toBe(true);
    expect(new Set(speakers).size).toBe(2); // 两轮换了人
  });

  test('群模式不提供附图入口，且退出后回到单角色', async ({ page }) => {
    await stubBackend(page);
    await page.goto('/');
    await enableGroupFlag(page);

    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await page.getByRole('button', { name: '群聊', exact: true }).click();
    await page.locator('button.pick', { hasText: CHAR_A }).click();
    await page.locator('button.pick', { hasText: CHAR_B }).click();
    await page.getByRole('button', { name: '开始群聊' }).click();

    // 群模式下没有「发送图片」按钮（群记录禁图 C-03）
    await expect(page.getByRole('button', { name: '发送图片' })).toHaveCount(0);
    // 顶栏显示群标记与成员数，不显示单角色对话切换
    await expect(page.getByText(/2 位成员/)).toBeVisible();

    // 退出群聊 → 回到单角色（无成员条）
    await page.getByRole('button', { name: '退出群聊' }).click();
    await expect(page.locator('[role="toolbar"][aria-label="群成员"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送图片' })).toHaveCount(1);
  });
});
