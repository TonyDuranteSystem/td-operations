import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: 'https://portal.tonydurante.us',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Primary browser — runs all tests
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Cross-browser — runs only cross-browser spec
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      testMatch: '**/cross-browser.spec.ts',
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testMatch: '**/cross-browser.spec.ts',
    },
  ],
  reporter: [['list']],
  // Visual regression: use toHaveScreenshot() in tests
  // Update baselines with: npx playwright test --update-snapshots
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.05, // Allow 5% pixel difference (font rendering)
    },
  },
})
