import { test, expect, type Page } from '@playwright/test';
import { meanRgb } from './png-mean';

/**
 * 对话背景层回归测试。
 *
 * 对应两条需求/缺陷：
 *  A. 历史缺陷：`.art-veil` 用**主题基色**（如沧溟奶油色 #faf2e0）叠加在媒体之上，
 *     切主题时整张背景跟着变色调、发白（用户感知为「背景被主题颜色糊住」）。
 *     修复后压暗罩只用中性黑，与主题彻底解耦。
 *  B. 背景属于**单个角色**的立绘，不是全局通用设置：给 A 角色选的自定义媒体
 *     不能在 B 角色下出现；每个角色各自回落到自己的头像。
 *
 * 断言（读真实渲染像素，非 DOM 结构）：
 *  1. 同一张媒体在 6 个主题下**内部区域平均 RGB 完全一致**；
 *  2. 压暗罩 computed 值只用中性黑，且各主题一致；
 *  3. 压暗强度 dim 可调（0 亮 / 90 暗，且始终中性）；
 *  4. 自定义图片生效、整幅铺满（--art-w 归零），与默认头像渲染不同；
 *  5. 自定义媒体加载失败 → 自动回落到**该角色**头像；
 *  6. 自定义视频走 `<video muted autoplay loop playsinline>` 分支；
 *  7. **按角色隔离**：切成 B 角色后不沿用 A 的自定义媒体，切回 A 又恢复。
 *
 * 做法：把 `tavern.backendUrl` 指向预览**同源**地址，再用 page.route 全面接管后端，
 * 媒体请求因此同源、无需 CORS，也不会打到真实后端。
 * 纯色媒体用内联 SVG 充当（红/绿=两个角色的头像、蓝=自定义），避免引入二进制 fixture。
 */

const THEME_IDS = ['cangming', 'xiuyan', 'qingchuan', 'meigui', 'qinglan', 'canglang'] as const;
const CHAR_A = '测试角色A';
const CHAR_B = '测试角色B';
const AVATAR_A = 'test-avatar.png';
const AVATAR_B = 'test-avatar-b.png';
const CUSTOM = 'test-custom.svg';
const VIDEO = 'test-loop.webm';

const solidSvg = (hex: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${hex}"/></svg>`;

/** 组装新的按角色存储结构（key = 角色头像文件名）。 */
const bgState = (perCharacter: Record<string, unknown> = {}, dim = 42) => ({ dim, perCharacter });
const customFor = (file: string, mediaType: 'image' | 'video' = 'image') => ({
  mode: 'custom',
  file,
  mediaType,
});

async function stubBackend(
  page: Page,
  opts: { customOk?: boolean; videoPending?: boolean } = {},
) {
  const { customOk = true, videoPending = false } = opts;
  // 所有后端请求改指向预览同源地址（page.route 才能无 CORS 接管）
  await page.addInitScript(() => {
    localStorage.setItem('tavern.backendUrl', location.origin);
    localStorage.setItem('tavern.backendEverReady', '1');
  });
  await page.route('**/tavern/health', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, mode: 'fallback' }),
    }),
  );
  // 两个角色：A 红、B 绿（用于验证按角色隔离）
  await page.route('**/api/characters/all', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { name: CHAR_A, avatar: AVATAR_A },
        { name: CHAR_B, avatar: AVATAR_B },
      ]),
    }),
  );
  await page.route(`**/characters/${AVATAR_A}`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg('#ff0000') }),
  );
  await page.route(`**/characters/${AVATAR_B}`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg('#00ff00') }),
  );
  if (videoPending) {
    // 视频请求保持挂起：<video> 既无数据也不触发 error，可稳定断言分支结构
    await page.route(`**/backgrounds/${VIDEO}`, () => new Promise<void>(() => {}));
  } else {
    // 自定义媒体：纯蓝；customOk=false 时返回 404 触发回落
    await page.route('**/backgrounds/**', (r) =>
      customOk
        ? r.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg('#0000ff') })
        : r.fulfill({ status: 404, body: '' }),
    );
  }
}

async function setBackground(page: Page, state: Record<string, unknown>) {
  await page.evaluate((s) => localStorage.setItem('tavern.background', JSON.stringify(s)), state);
}

/** 隐藏应用外壳后只截背景层，得到不受 UI 干扰的纯净背景像素；截完立即恢复外壳。 */
async function snapBg(page: Page) {
  const hide = await page.addStyleTag({ content: '.shell{display:none !important}' });
  await page.waitForTimeout(80);
  const shot = await page.locator('.bg').screenshot();
  // 必须撤销：否则后续步骤里导航按钮全都不可见（UI 被藏起来了）
  await hide.evaluate((el) => el.remove());
  return shot;
}

/** 逐一应用 6 个主题，各截一张背景图，返回其内部平均色。 */
async function backgroundColorPerTheme(page: Page) {
  const means: [number, number, number][] = [];
  const veils: string[] = [];
  for (const id of THEME_IDS) {
    await page.evaluate((t) => localStorage.setItem('tavern.theme', t), id);
    await page.reload();
    await expect(page.locator('.bg .art')).toBeVisible();
    await page.waitForTimeout(450); // 等主题过渡结束
    veils.push(
      await page.locator('.art-veil').evaluate((el) => getComputedStyle(el).backgroundImage),
    );
    means.push(meanRgb(await snapBg(page)));
  }
  return { means, veils };
}

function expectSameRgb(actual: [number, number, number], base: [number, number, number], label: string) {
  for (let c = 0; c < 3; c++) {
    expect(Math.abs(actual[c] - base[c]), `${label} 第 ${c} 通道偏移`).toBeLessThan(0.01);
  }
}

/** 通过「角色」页切换到指定角色（pick() 会自动回到聊天页）。 */
async function switchCharacter(page: Page, name: string) {
  await page.getByRole('button', { name: '角色', exact: true }).first().click();
  await page.locator('button.pick', { hasText: name }).first().click();
  await expect(page.locator('.composer')).toBeVisible();
}

test.describe('对话背景层', () => {
  test('自定义背景不随主题变色（含横屏，整幅铺满）', async ({ page }) => {
    await stubBackend(page);
    await page.goto('/');
    await setBackground(page, bgState({ [AVATAR_A]: customFor(CUSTOM) }));
    await page.reload();

    const { means, veils } = await backgroundColorPerTheme(page);
    for (let i = 1; i < means.length; i++) {
      expectSameRgb(means[i], means[0], `主题 ${THEME_IDS[i]}`);
    }
    // 媒体是纯蓝 SVG，压暗罩是中性黑：红/绿通道必须为 0（若被主题色糊住会抬升）
    expect(means[0][0]).toBeLessThan(0.5);
    expect(means[0][1]).toBeLessThan(0.5);
    expect(means[0][2]).toBeGreaterThan(100); // 蓝通道可见 → 媒体确实被渲染
    // 压暗罩本身也必须与主题无关，且只用中性黑
    for (let i = 1; i < veils.length; i++) expect(veils[i]).toBe(veils[0]);
    expect(veils[0]).toMatch(/rgba?\(0, 0, 0/);
  });

  test('默认头像背景不随主题变色（竖屏）', async ({ page }) => {
    const size = page.viewportSize()!;
    // 横屏下默认头像按设计改 contain 靠右、左侧留白由主题渐变填充，故只验竖屏
    test.skip(size.width >= size.height, '横屏默认头像为 contain 让位布局，留白本就随主题');

    await stubBackend(page);
    await page.goto('/');
    await setBackground(page, bgState());
    await page.reload();
    await expect(page.locator('.bg img.art')).toBeVisible();

    const { means } = await backgroundColorPerTheme(page);
    for (let i = 1; i < means.length; i++) {
      expectSameRgb(means[i], means[0], `主题 ${THEME_IDS[i]}`);
    }
    // 红色头像 + 中性罩 → 绿/蓝为 0，红可见
    expect(means[0][1]).toBeLessThan(0.5);
    expect(means[0][2]).toBeLessThan(0.5);
    expect(means[0][0]).toBeGreaterThan(100);
  });

  test('压暗强度可调：dim 0 亮、dim 90 暗，且始终中性', async ({ page }) => {
    await stubBackend(page);
    await page.goto('/');

    // 用自定义整幅背景（蓝），使该用例与朝向无关（默认头像横屏是 contain 让位布局）
    const state = (dim: number) => bgState({ [AVATAR_A]: customFor(CUSTOM) }, dim);
    await setBackground(page, state(0));
    await page.reload();
    await expect(page.locator('.bg img.art')).toBeVisible();
    const bright = meanRgb(await snapBg(page));

    await setBackground(page, state(90));
    await page.reload();
    await expect(page.locator('.bg img.art')).toBeVisible();
    const dark = meanRgb(await snapBg(page));

    expect(bright[2]).toBeGreaterThan(200); // 无压暗 → 接近纯蓝 255
    expect(dark[2]).toBeLessThan(60); // 压暗 90% → 约 25
    expect(bright[2]).toBeGreaterThan(dark[2]);
    // 中性罩不引入色偏：两种情况红/绿都应为 0
    for (const m of [bright, dark]) {
      expect(m[0]).toBeLessThan(0.5);
      expect(m[1]).toBeLessThan(0.5);
    }
  });

  test('自定义图片生效并整幅铺满（--art-w 归零）', async ({ page }) => {
    await stubBackend(page, { customOk: true });
    await page.goto('/');
    await setBackground(page, bgState({ [AVATAR_A]: customFor(CUSTOM) }));
    await page.reload();

    const art = page.locator('.bg img.art');
    await expect(art).toBeVisible();
    await expect(art).toHaveAttribute('src', /\/backgrounds\/test-custom\.svg$/);
    await expect(page.locator('.shell')).toHaveClass(/bg-cover/);
    // 自定义背景整幅铺满，气泡不再让位：--art-w 必须归零
    const artW = await page
      .locator('.shell')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--art-w').trim());
    expect(artW).toBe('0px');

    const custom = meanRgb(await snapBg(page));

    // 清除后应回到该角色头像（红）→ 证明自定义媒体确实生效（蓝）
    await setBackground(page, bgState());
    await page.reload();
    await expect(page.locator('.bg img.art')).toBeVisible();
    const auto = meanRgb(await snapBg(page));

    expect(custom[2]).toBeGreaterThan(custom[0]); // 蓝占优
    expect(auto[0]).toBeGreaterThan(auto[2]); // 红占优
  });

  test('自定义媒体加载失败 → 自动回落到该角色头像', async ({ page }) => {
    await stubBackend(page, { customOk: false }); // backgrounds 一律 404
    await page.goto('/');
    await setBackground(page, bgState({ [AVATAR_A]: customFor(CUSTOM) }));
    await page.reload();

    const art = page.locator('.bg img.art');
    await expect(art).toBeVisible();
    // 兜底：src 从 backgrounds/ 切回 characters/ 头像
    await expect(art).toHaveAttribute('src', /\/characters\/test-avatar\.png$/);
    // 整幅铺满标记随回落一并撤销（恢复默认头像的让位策略）
    await expect(page.locator('.shell')).not.toHaveClass(/bg-cover/);
    // 渲染内容确为头像（红占优）
    const m = meanRgb(await snapBg(page));
    expect(m[0]).toBeGreaterThan(m[2]);
  });

  test('自定义视频走 <video> 分支且静音自动循环', async ({ page }) => {
    await stubBackend(page, { videoPending: true });
    await page.goto('/');
    await setBackground(page, bgState({ [AVATAR_A]: customFor(VIDEO, 'video') }));
    await page.reload();

    const video = page.locator('.bg video.art');
    await expect(video).toHaveCount(1);
    await expect(page.locator('.bg img.art')).toHaveCount(0);
    await expect(video).toHaveAttribute('src', /\/backgrounds\/test-loop\.webm$/);
    // Android WebView 自动播放的前提：静音 + playsinline + autoplay + loop
    // 注意 muted 是 IDL 属性、不反射为 HTML 属性，故直接断言 property
    expect(await video.evaluate((el) => (el as HTMLVideoElement).muted)).toBe(true);
    await expect(video).toHaveAttribute('autoplay', '');
    await expect(video).toHaveAttribute('loop', '');
    await expect(video).toHaveAttribute('playsinline', '');
  });

  test('背景按角色隔离：A 的自定义媒体不会出现在 B 身上', async ({ page }) => {
    await stubBackend(page, { customOk: true });
    await page.goto('/');
    // 只给 A 角色配自定义媒体
    await setBackground(page, bgState({ [AVATAR_A]: customFor(CUSTOM) }));
    await page.reload();

    // A：自定义蓝图 + 整幅铺满
    const art = page.locator('.bg .art');
    await expect(art).toHaveAttribute('src', /\/backgrounds\/test-custom\.svg$/);
    await expect(page.locator('.shell')).toHaveClass(/bg-cover/);
    const aMeans = meanRgb(await snapBg(page));
    expect(aMeans[2]).toBeGreaterThan(aMeans[0]); // 蓝占优

    // 切到 B：必须用自己的头像（绿），且不再整幅铺满
    await switchCharacter(page, CHAR_B);
    await expect(art).toHaveAttribute('src', /\/characters\/test-avatar-b\.png$/);
    await expect(page.locator('.shell')).not.toHaveClass(/bg-cover/);
    const bMeans = meanRgb(await snapBg(page));
    expect(bMeans[1]).toBeGreaterThan(bMeans[0]); // 绿占优
    expect(bMeans[1]).toBeGreaterThan(bMeans[2]);

    // 切回 A：自定义媒体仍在（设置是持久的，未被 B 覆盖）
    await switchCharacter(page, CHAR_A);
    await expect(art).toHaveAttribute('src', /\/backgrounds\/test-custom\.svg$/);
    await expect(page.locator('.shell')).toHaveClass(/bg-cover/);
  });
});
