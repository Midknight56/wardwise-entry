import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: 'chromium', headless: true,
    baseURL: process.env.WW_BASE || 'http://127.0.0.1:18823',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', testMatch: /(?:judge-path|ask|layout)\.spec\.ts/, grepInvert: /@money/, use: {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    } },
  ],
});
