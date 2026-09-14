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
    // 输入区：placeholder 随服务状态变化（就绪前是「正在准备…」），
    // 故断言稳定的 aria-label 而不是文案
    await expect(page.getByLabel('消息输入')).toBeVisible();
    // 发送按钮（exact：输入区还有「发送图片」按钮，模糊匹配会撞上它）
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
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
    // demo 数据是 2 轮问答 → 4 条消息（此前断言的 5 是旧数据残留）
    await expect(wrappers).toHaveCount(4);

    const viewport = page.viewportSize()!;
    // 左右对齐作用在 .msg-body 上（.msg-user / .msg-assistant 两条规则），
    // 而 .msg-wrapper 是整行。桌面端消息列本身居中，故断言「气泡贴所在行的
    // 哪一侧」而不是「贴视口哪一侧」—— 后者会随列宽与居中方式变化而假红。
    const aWrap = page.locator('.msg-wrapper.msg-assistant').first();
    const uWrap = page.locator('.msg-wrapper.msg-user').first();
    const aBox = await aWrap.boundingBox();
    const uBox = await uWrap.boundingBox();
    const aBody = await aWrap.locator('.msg-body').boundingBox();
    const uBody = await uWrap.locator('.msg-body').boundingBox();
    expect(aBox).not.toBeNull();
    expect(uBox).not.toBeNull();
    expect(aBody).not.toBeNull();
    expect(uBody).not.toBeNull();
    expect(viewport).not.toBeNull();

    // 角色消息靠左：气泡左边贴近本行左边（差额只该是头像与间距）
    expect(aBody!.x - aBox!.x).toBeLessThan(aBox!.width * 0.25);
    // 用户消息靠右：气泡右边贴近本行右边
    expect(uBox!.x + uBox!.width - (uBody!.x + uBody!.width)).toBeLessThan(uBox!.width * 0.25);
    // 两者确实分处两侧，而不是同侧堆叠
    expect(aBody!.x).toBeLessThan(uBody!.x);
  });

  test('导航可切换到设置页', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).first().click();

    // 设置首页有「外观」入口（Tavo 风格的分组行）
    const appearance = page.getByRole('button', { name: '外观' }).first();
    await expect(appearance).toBeVisible();

    // 进外观子页：主题选择器 6 套 + 当前主题行
    await appearance.click();
    await expect(page.getByRole('radiogroup', { name: '主题选择' })).toBeVisible();
    await expect(page.locator('.theme-card')).toHaveCount(6);
    await expect(page.getByText('当前主题')).toBeVisible();
  });
});
