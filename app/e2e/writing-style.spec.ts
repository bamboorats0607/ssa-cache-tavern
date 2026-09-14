import { test, expect, type Page } from '@playwright/test';

/**
 * 写作风格接入回归（Phase 1 / 1b / 3）。
 *
 * 断言的是**请求形状**与**渲染条数**，不是「点了没报错」：
 *  1. 默认开聊天体 → 前缀区恰好注入 1 个风格 system 块，且排在角色块之后；
 *  2. 关掉聊天体 → 该块消失（等价于未接入）；
 *  3. 默认参数（topK=0 / seed=-1 / forceSamplers=关）→ 请求体**不含**这些键，
 *     保证「没动过设置」的请求体与接入前逐字节一致；
 *  4. 偏离默认值 → top_k / seed 真正下发；
 *  5. forceSamplers → min_p / repetition_penalty 经 custom_include_body
 *     以 **YAML 字符串**下发（传对象会被后端 yaml.parse 静默吞掉）；
 *  6. 分条渲染：短句多行 → 多个气泡；关掉开关 → 仍是单气泡。
 *
 * 风格块的文案**不在**这里断言（改一个字不该让 e2e 红），
 * 文案政策与归一化在 `scripts/check-style-guide.mjs` 里管。
 */

const CHAT_MARK = '【说话方式 · 聊天体】';
const NARRATION_MARK = '【叙述 · 手写感】';

const CHAR = '测试角色A';
const AVATAR = 'test-a.png';
const svg = (hex: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${hex}"/></svg>`;

const HEALTH = { ok: true, mode: 'fallback' };

/** 捕获生成请求体；回复内容由调用方给定（含换行时用于分条断言）。 */
async function stubBackend(page: Page, reply: string) {
  await page.addInitScript(() => {
    localStorage.setItem('tavern.backendUrl', location.origin);
    localStorage.setItem('tavern.backendEverReady', '1');
  });
  await page.route('**/tavern/health', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/characters/all', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ name: CHAR, avatar: AVATAR, description: 'A 的设定文本' }]),
    }),
  );
  await page.route('**/api/characters/get', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route(`**/characters/${AVATAR}`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg('#ff0000') }),
  );
  await page.route('**/api/worldinfo/list', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/csrf-token', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'disabled' }) }),
  );

  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/backends/chat-completions/generate', async (r) => {
    bodies.push(JSON.parse(r.request().postData() ?? '{}'));
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 512 } },
      }),
    });
  });
  return bodies;
}

/** 发一条消息并等回复落地。 */
async function send(page: Page, text: string) {
  await page.getByLabel('消息输入').fill(text);
  // exact：输入区还有「发送图片」按钮，模糊匹配会撞上它
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

/** 用 localStorage 预置 store（等价于设置页操作，测试里更快更稳）。 */
async function seed(page: Page, key: string, value: unknown) {
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [
    key,
    JSON.stringify(value),
  ] as const);
  await page.reload();
  await page.waitForTimeout(400);
}

/** 选一个角色（角色块只有存在角色设定时才会出现，顺序断言需要它）。 */
async function pickChar(page: Page) {
  await page.getByRole('button', { name: '角色', exact: true }).first().click();
  await page.locator('button.pick', { hasText: CHAR }).click();
  await expect(page.locator('.who-name')).toHaveText(CHAR);
}

test.describe('写作风格', () => {
  test('默认注入：风格块恰好一个，且排在角色块之后', async ({ page }) => {
    const bodies = await stubBackend(page, '嗯。');
    await page.goto('/');
    await pickChar(page);
    await send(page, '在吗');
    await expect(page.getByText('嗯。')).toBeVisible({ timeout: 10_000 });

    expect(bodies.length).toBe(1);
    const msgs = bodies[0].messages as { role: string; content: string }[];

    // 恰好一个风格块（重复注入会同时破坏前缀缓存与语义）
    const hits = msgs
      .map((m, i) => ({ i, role: m.role, text: String(m.content) }))
      .filter((m) => m.text.includes(CHAT_MARK));
    expect(hits.length).toBe(1);

    // 位置：角色块（含「角色设定：」）在 0，风格块紧随其后
    expect(msgs[0].role).toBe('system');
    expect(String(msgs[0].content)).toContain('角色设定：');
    expect(String(msgs[0].content).includes(CHAT_MARK)).toBe(false);
    const styleIdx = hits[0].i;
    expect(hits[0].role).toBe('system');
    expect(styleIdx).toBe(1);

    // 默认注册含叙述块（聊天体与叙述块成对出现）
    expect(hits[0].text.includes(NARRATION_MARK)).toBe(true);

    // 默认参数不下发：请求体保持与接入前逐字节一致
    expect('top_k' in bodies[0]).toBe(false);
    expect('seed' in bodies[0]).toBe(false);
    expect('custom_include_body' in bodies[0]).toBe(false);
  });

  test('关掉聊天体：不再注入风格块', async ({ page }) => {
    const bodies = await stubBackend(page, '嗯。');
    await page.goto('/');
    await seed(page, 'tavern.writingStyle', {
      register: false,
      depth: 'none',
      lens: 'direct',
      sample: '',
      burst: true,
    });
    await send(page, '在吗');
    await expect(page.getByText('嗯。')).toBeVisible({ timeout: 10_000 });

    expect(bodies.length).toBe(1);
    const msgs = bodies[0].messages as { role: string; content: string }[];
    for (const m of msgs) {
      expect(String(m.content).includes(CHAT_MARK)).toBe(false);
      expect(String(m.content).includes(NARRATION_MARK)).toBe(false);
    }
  });

  test('Phase 3：top_k / seed 真正下发，扩展采样走 YAML 字符串', async ({ page }) => {
    const bodies = await stubBackend(page, '嗯。');
    await page.goto('/');

    // 1) 偏离默认 → 下发
    await seed(page, 'tavern.model', { topK: 40, seed: 12345 });
    await send(page, '在吗');
    await expect(page.getByText('嗯。')).toBeVisible({ timeout: 10_000 });
    expect(bodies[0].top_k).toBe(40);
    expect(bodies[0].seed).toBe(12345);

    // 2) 强制下发扩展采样：必须是 YAML **字符串**（对象会被后端静默吞掉）
    await seed(page, 'tavern.model', { forceSamplers: true, minP: 0.05, repPen: 1.1 });
    await send(page, '再来');
    await expect.poll(() => bodies.length).toBe(2);
    const yaml = bodies[1].custom_include_body;
    expect(typeof yaml).toBe('string');
    expect(String(yaml)).toContain('min_p: 0.05');
    expect(String(yaml)).toContain('repetition_penalty: 1.1');
  });

  test('分条渲染：开关开则多气泡，关则单气泡', async ({ page }) => {
    // 两行短句 → 满足分条闸门（无空行、每行 ≤ 48 字、2~6 行）
    const bodies = await stubBackend(page, '行吧\n那我先去睡了');
    await page.goto('/');

    await send(page, '睡了吗');
    // 用户 1 气泡 + 助手 2 气泡
    await expect(page.locator('.msg-wrapper')).toHaveCount(3, { timeout: 10_000 });
    expect(bodies.length).toBe(1);

    // 关掉分条 → 同一条回复只占 1 个气泡
    await seed(page, 'tavern.writingStyle', {
      register: true,
      depth: 'none',
      lens: 'direct',
      sample: '',
      burst: false,
    });
    await send(page, '睡了吗');
    await expect(page.locator('.msg-wrapper')).toHaveCount(4, { timeout: 10_000 });
  });
});
