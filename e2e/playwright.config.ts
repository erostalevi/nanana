import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './lib/env';

export default defineConfig({
  testDir: './tests',
  // One worker: every test shares the nanana_test database and the single API process.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    permissions: ['clipboard-read', 'clipboard-write'],
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
