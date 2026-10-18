import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:4319',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { ...(systemChromium ? { executablePath: systemChromium } : {}), args: ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'] },
  },
  webServer: {
    command: 'node --import tsx tests/fixtures/e2e-server.ts',
    url: 'http://127.0.0.1:4319/api/state',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
