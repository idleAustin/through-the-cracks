// Playwright end-to-end smoke configuration for desktop (1440x900) and mobile web (375x812).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.cache/playwright/test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-1440',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-375',
      use: { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
    },
  ],
  webServer: {
    command: 'VITE_BASE_PATH=/ VITE_API_URL=/api npx vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
