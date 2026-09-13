import { defineConfig, devices } from '@playwright/test';

/**
 * Tavern 前端 E2E 配置。
 *
 * 要点：
 *  - webServer 自动起 vite preview，测试无需手动开服务
 *  - 复用本机已装 Chromium（PLAYWRIGHT_BROWSERS_PATH 由环境变量指定），避免重复下载
 *  - 移动端与桌面端各一份 project，覆盖跨端布局
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
      },
    },
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
