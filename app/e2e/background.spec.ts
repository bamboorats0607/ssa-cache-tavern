import { test, expect, type Page } from '@playwright/test';
import { meanRgb } from './png-mean';

/**
 * 对话背景层回归测试。
 *
 * 对应历史缺陷：`.art-veil` 用**主题基色**（如沧溟奶油色 #faf2e0）叠加在媒体之上，
 * 于是切主题时整张背景跟着变色调、发白，用户感知为「背景被主题颜色糊住、
 * 像压在图层最底层」。修复后压暗罩只用中性黑，与主题彻底解耦。
 *
 * 断言（读真实渲染像素，非 DOM 结构）：
 *  1. 同一张媒体在 6 个主题下**内部区域平均 RGB 完全一致** → 背景不受主题配色影响；
 *  2. 压暗罩 computed 值只用中性黑，且各主题一致；
 *  3. 压暗强度 dim 可调（0 亮、90 暗，且始终保持中性）；
 *  4. 自定义图片生效、整幅铺满（--art-w 归零），与默认头像渲染不同；
 *  5. 自定义媒体加载失败 → 自动回落到角色头像；
 *  6. 自定义视频走 `<video muted autoplay loop playsinline>` 分支。
 *
 * 做法：把 `tavern.backendUrl` 指向预览**同源**地址，再用 page.route 全面接管后端，
 * 媒体请求因此同源、无需 CORS，也不会打到真实后端。
 * 纯色媒体用内联 SVG 充当（红=头像、蓝=自定义），避免引入二进制 fixture。
 */

const THEME_IDS = ['cangming', 'xiuyan', 'qingchuan', 'meigui', 'qinglan', 'canglang'] as const;
const AVATAR = 'test-avatar.png';
const CUSTOM = 'test-custom.svg';
const VIDEO = 'test-loop.webm';

const solidSvg = (hex: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${hex}"/></svg>`;

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
  await page.route('**/api/characters/all', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ name: '测试角色', avatar: AVATAR }]),
    }),
  );
  // 角色头像：纯红
  await page.route(`**/characters/${AVATAR}`, (r) =>
    r.fulfill({ status: 200, contentType: 'image/svg+xml', body: solidSvg('#ff0000') }),
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

/** 隐藏应用外壳后只截背景层，得到不受 UI 干扰的纯净背景像素。 */
async function snapBg(page: Page) {
  await page.addStyleTag({ content: '.shell{display:none !important}' });
  await page.waitForTimeout(80);
  return page.locator('.bg').screenshot();
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

test.describe('对话背景层', () => {
  test('自定义背景不随主题变色（含横屏，整幅铺满）', async ({ page }) => {
    await stubBackend(page);
    await page.goto('/');
    await setBackground(page, { mode: 'custom', file: CUSTOM, mediaType: 'image', dim: 42 });
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
    await setBackground(page, { mode: 'custom', file: CUSTOM, mediaType: 'image', dim: 0 });
    await page.reload();
    await expect(page.locator('.bg img.art')).toBeVisible();
    const bright = meanRgb(await snapBg(page));

    await setBackground(page, { mode: 'custom', file: CUSTOM, mediaType: 'image', dim: 90 });
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
    await setBackground(page, { mode: 'custom', file: CUSTOM, mediaType: 'image', dim: 42 });
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

    // 切回默认头像（红）后渲染应明显不同 → 证明自定义媒体确实生效（蓝）
    await setBackground(page, { mode: 'auto', file: null, mediaType: 'image', dim: 42 });
    await page.reload();
    await expect(page.locator('.bg img.art')).toBeVisible();
    const auto = meanRgb(await snapBg(page));

    expect(custom[2]).toBeGreaterThan(custom[0]); // 蓝占优
    expect(auto[0]).toBeGreaterThan(auto[2]); // 红占优
  });

  test('自定义媒体加载失败 → 自动回落到角色头像', async ({ page }) => {
    await stubBackend(page, { customOk: false }); // backgrounds 一律 404
    await page.goto('/');
    await setBackground(page, { mode: 'custom', file: CUSTOM, mediaType: 'image', dim: 42 });
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
    await setBackground(page, { mode: 'custom', file: VIDEO, mediaType: 'video', dim: 42 });
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
});
