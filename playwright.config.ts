import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for OpenMAIC-RU.
 *
 * Notes (osvaivai fork):
 * - Dev/CI start Next.js without INTERNAL_ACCESS_KEY env, so the middleware
 *   (middleware.ts) falls through unchanged and /api/* is reachable from tests.
 *   If you ever want to test the gated path, set INTERNAL_ACCESS_KEY both on
 *   webServer.env AND pass header `X-Internal-Key` via extraHTTPHeaders.
 * - Locale specs that need a stable language must seed `localStorage.locale`
 *   in `page.addInitScript` (see e2e/tests/embedded-osvaivai.spec.ts).
 */
export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'ru-RU',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.CI ? 'pnpm build && pnpm start' : 'pnpm dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      PORT: '3002',
      // Explicitly unset INTERNAL_ACCESS_KEY: middleware short-circuits and
      // lets /api/* through, which is what mock-api fixtures expect.
      INTERNAL_ACCESS_KEY: '',
    },
  },
});
