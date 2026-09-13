import { test, expect } from '@playwright/test';

/**
 * UI 视觉与布局测试。
 *
 * 覆盖：
 *  - 四层导航存在且可切换
 *  - 聊天页三大区域（顶栏/消息区/输入区）渲染完整
 *  - 底部导航不溢出、不遮挡输入框（真实几何断言，而非肉眼）
 *  - 用户/角色气泡左右分侧（走真实 Svelte 渲染，非 DOM 注入）
 */
test.describe('Tavern UI', () => {
  test('四层导航渲染完整', async ({ page }) => {
    await page.goto('/');

    // 主导航项（移动端底部栏 / 桌面端侧边栏，两套都会渲染同一批 label）
    for (const label of ['聊天', '角色', '世界书', '设置']) {
      await expect(page.getByRole('button', { name: label }).first()).toBeVisible();
    }
  });

  test('聊天页三大区域齐全', async ({ page }) => {
    await page.goto('/');

    // 顶栏（角色名）：移动端侧边栏隐藏，故只取可见的那个
    await expect(page.locator('.who-name')).toHaveText('Tavern');
    await expect(page.locator('.who-name')).toBeVisible();
    // 输入区
    await expect(page.getByPlaceholder(/说点什么/)).toBeVisible();
    // 发送按钮
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
  });

  test('底部导航不溢出、不遮挡输入框', async ({ page, isMobile }) => {
    test.skip(!isMobile, '仅移动端有底部标签栏');

    await page.goto('/');

    const tabbar = page.locator('nav[aria-label="主导航"]').last();
    const composer = page.locator('.composer');
    await expect(tabbar).toBeVisible();
    await expect(composer).toBeVisible();

    const tabBarBox = await tabbar.boundingBox();
    const composerBox = await composer.boundingBox();
    const viewport = page.viewportSize();
    expect(tabBarBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(viewport).not.toBeNull();

    // 1) 导航栏不超出视口
    expect(tabBarBox!.x).toBeGreaterThanOrEqual(0);
    expect(tabBarBox!.x + tabBarBox!.width).toBeLessThanOrEqual(viewport!.width + 1);

    // 2) 输入框底边在导航栏顶边之上（即不被遮挡）
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(tabBarBox!.y + 1);

    // 3) 每个 tab 都在导航栏容器内
    const tabs = tabbar.locator('button');
    const count = await tabs.count();
    expect(count).toBe(4);
    for (let i = 0; i < count; i++) {
      const b = await tabs.nth(i).boundingBox();
      expect(b).not.toBeNull();
      expect(b!.x).toBeGreaterThanOrEqual(tabBarBox!.x - 1);
      expect(b!.x + b!.width).toBeLessThanOrEqual(tabBarBox!.x + tabBarBox!.width + 1);
    }
  });

  test('消息气泡左右分侧正确', async ({ page }) => {
    // ?demo=1 走真实 Svelte 渲染路径预置消息
    await page.goto('/?demo=1');

    const wrappers = page.locator('.msg-wrapper');
    await expect(wrappers).toHaveCount(5);

    const viewport = page.viewportSize()!;
    const first = await wrappers.first().boundingBox();   // assistant
    const second = await wrappers.nth(1).boundingBox();   // user
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // 角色消息应靠左：其左边贴近视口左侧
    expect(first!.x).toBeLessThan(viewport.width * 0.25);
    // 用户消息应靠右：其右边贴近视口右侧
    expect(second!.x + second!.width).toBeGreaterThan(viewport.width * 0.75);
  });

  test('导航可切换到设置页', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).first().click();
    // 设置页应展示主题选择与后端信息
    await expect(page.getByText('外观主题')).toBeVisible();
    await expect(page.locator('.theme-card')).toHaveCount(6);
  });
});
