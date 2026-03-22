import { defineConfig } from '@playwright/test'
import * as path from 'path'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  // globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'https://portal.tonydurante.us',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // storageState: path.join(__dirname, 'tests/e2e/.auth-state.json'),
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  reporter: [['list']],
})
