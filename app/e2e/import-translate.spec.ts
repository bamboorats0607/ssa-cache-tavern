import { test, expect, type Page } from '@playwright/test';

/**
 * 导入（角色卡 / 世界书）、角色卡翻译、使用情况入口 —— 回归测试。
 *
 * 全部走**真实组件 + 真实请求形状**：断言发出的请求体（字段名 / file_type / lang）
 * 与上游契约一致，而不只是「点了没报错」。
 *
 * 上游契约（server-ref）：
 *  · 角色卡导入 `POST /api/characters/import`：multipart，字段 `avatar` + **必填** `file_type`
 *    （json/png/yaml/yml/charx/byaf）；成功 `{ file_name }`，失败**也是 200 + { error: true }**。
 *  · 世界书导入 `POST /api/worldinfo/import`：multipart，字段 `avatar`，可选 `name` → `{ name }`。
 *  · 翻译 `POST /api/translate/google`：JSON `{ text, lang }` → **纯文本**译文。
 */

const CHAR = { name: '测试角色', avatar: 'test-avatar.png', description: 'A stoic knight from the north.' };

async function stubBase(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('tavern.backendUrl', location.origin);
    localStorage.setItem('tavern.backendEverReady', '1');
  });
  await page.route('**/tavern/health', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mode: 'fallback' }) }),
  );
  await page.route('**/characters/test-avatar.png', (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#f00"/></svg>' }),
  );
  await page.route('**/api/worldinfo/list', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/characters/get', (r) => r.fulfill({ status: 404, body: '' }));
}

test.describe('角色卡 / 世界书导入', () => {
  test('角色卡导入：按扩展名带 file_type，成功后刷新列表并提示', async ({ page }) => {
    await stubBase(page);
    let imported = false;
    let seenType = '';
    await page.route('**/api/characters/all', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(imported ? [CHAR, { name: '导入的角色', avatar: 'imported.png' }] : [CHAR]),
      }),
    );
    await page.route('**/api/characters/import', async (r) => {
      // 断言请求确实带了 file_type（上游按它分派导入函数；缺失会 Unsupported format）
      const body = r.request().postDataBuffer()?.toString('latin1') ?? '';
      seenType = /name="file_type"\s*\r?\n\r?\njson/.test(body) ? 'json' : 'MISSING';
      imported = true;
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file_name: 'imported.png' }) });
    });

    await page.goto('/');
    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await expect(page.locator('h1')).toHaveText('角色');

    await page.locator('input.file-input[accept*=".json"]').setInputFiles({
      name: 'my-card.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"name":"x"}'),
    });

    await expect(page.getByText('已导入「imported.png」')).toBeVisible();
    expect(seenType).toBe('json');
    // 列表已刷新（新角色出现在列表里）
    await expect(page.getByText('导入的角色')).toBeVisible();
  });

  test('角色卡导入：后端返回 {error:true}（HTTP 200）也要识别为失败', async ({ page }) => {
    await stubBase(page);
    await page.route('**/api/characters/all', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CHAR]) }),
    );
    await page.route('**/api/characters/import', (r) =>
      // 上游失败路径：HTTP 200 + { error: true }
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: true }) }),
    );

    await page.goto('/');
    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await page.locator('input.file-input[accept*=".json"]').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('not a card'),
    });
    await expect(page.getByText('这个文件不是有效的角色卡（或格式不受支持）')).toBeVisible();
  });

  test('不支持的扩展名：本地拦截，不发请求', async ({ page }) => {
    await stubBase(page);
    await page.route('**/api/characters/all', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CHAR]) }),
    );
    let called = false;
    await page.route('**/api/characters/import', (r) => {
      called = true;
      return r.fulfill({ status: 200, body: '{}' });
    });

    await page.goto('/');
    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await page.locator('input.file-input[accept*=".json"]').setInputFiles({
      name: 'card.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
    await expect(page.getByText(/不支持的格式/)).toBeVisible();
    expect(called).toBe(false);
  });

  test('世界书导入：带 name 字段，成功后刷新', async ({ page }) => {
    await stubBase(page);
    let imported = false;
    let bodyText = '';
    await page.route('**/api/worldinfo/list', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(imported ? [{ file_id: 'lore', name: 'lore' }] : []),
      }),
    );
    await page.route('**/api/worldinfo/get', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: {} }) }),
    );
    await page.route('**/api/worldinfo/import', async (r) => {
      bodyText = r.request().postDataBuffer()?.toString('utf8') ?? '';
      imported = true;
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'lore' }) });
    });

    await page.goto('/');
    await page.getByRole('button', { name: '世界书', exact: true }).first().click();
    await page.locator('input.file-input[accept=".json"]').setInputFiles({
      name: 'lore.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"entries":{}}'),
    });

    await expect(page.getByText('已导入「lore」')).toBeVisible();
    expect(bodyText).toContain('name="name"');
    expect(bodyText).toContain('lore');
  });
});

test.describe('角色卡翻译', () => {
  test('翻译→预览→应用到表单，请求体为 {text, lang} 且角色名不被翻译', async ({ page }) => {
    await stubBase(page);
    await page.route('**/api/characters/all', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CHAR]) }),
    );
    const seen: Array<Record<string, unknown>> = [];
    await page.route('**/api/translate/google', async (r) => {
      seen.push(JSON.parse(r.request().postData() ?? '{}'));
      await r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '来自北方的沉默骑士。' });
    });

    await page.goto('/');
    await page.getByRole('button', { name: '角色', exact: true }).first().click();
    await page.getByRole('button', { name: '编辑角色' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '翻译', exact: true }).click();
    await page.getByRole('button', { name: '开始翻译' }).click();

    // 预览出现，且**没有**直接覆盖表单
    await expect(page.getByText('来自北方的沉默骑士。')).toBeVisible();
    const nameInput = page.getByRole('dialog').locator('input.input').first();
    await expect(nameInput).toHaveValue('测试角色');
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({ text: CHAR.description, lang: 'zh-CN' });

    await page.getByRole('button', { name: '应用到表单' }).click();
    // 描述被写入表单，角色名不变
    await expect(page.getByRole('dialog').locator('textarea.textarea').first()).toHaveValue('来自北方的沉默骑士。');
    await expect(nameInput).toHaveValue('测试角色');
  });
});

test.describe('使用情况入口', () => {
  test('无数据时显示可执行提示，且位于设置第一组（首屏可见）', async ({ page }) => {
    await stubBase(page);
    await page.route('**/api/characters/all', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CHAR]) }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).first().click();

    const row = page.locator('.row', { hasText: '使用情况' }).first();
    await expect(row).toBeVisible(); // 首屏即可见（无需滚动）
    await expect(row).toContainText('聊一句即开始统计');
    // 它在第一个分组里
    const firstGroup = page.locator('.group-body').first();
    await expect(firstGroup.getByText('使用情况')).toBeVisible();
  });

  test('有数据时摘要显示轮次与命中率', async ({ page }) => {
    await stubBase(page);
    await page.route('**/api/characters/all', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CHAR]) }),
    );
    await page.goto('/');
    await page.evaluate(() => {
      const stats = (input: number, cached: number) => ({
        inputTokens: input,
        outputTokens: 10,
        cachedTokens: cached,
        inputMeasured: true,
        breakdown: { prefix: 1, suffix: 1, liveClusters: 0, facts: 0, leaf: 0 },
      });
      localStorage.setItem(
        'tavern.sessions',
        JSON.stringify([
          {
            id: 's1',
            characterName: '测试角色',
            title: 't',
            renamed: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            turns: [
              { id: 't1', round: 1, at: Date.now(), userText: 'a', assistantText: 'b', durationMs: 1, model: 'm', stats: stats(1000, 500) },
              { id: 't2', round: 2, at: Date.now(), userText: 'c', assistantText: 'd', durationMs: 1, model: 'm', stats: stats(1000, 800) },
            ],
          },
        ]),
      );
    });
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).first().click();
    const row = page.locator('.row', { hasText: '使用情况' }).first();
    await expect(row).toContainText('2 轮');
    await expect(row).toContainText('命中 65%'); // (500+800)/2000 = 65%
  });
});
