/**
 * VISUAL REGRESSION TESTS
 * Screenshots every key page and compares pixel-by-pixel on next run.
 * First run creates baselines in tests/e2e/visual-regression.spec.ts-snapshots/
 * Subsequent runs compare against baselines — catches CSS breaks.
 *
 * Update baselines: npx playwright test visual-regression --update-snapshots
 */
import { test, expect, type Page } from '@playwright/test'

const CRM = 'https://td-operations.vercel.app'
const PORTAL = 'https://portal.tonydurante.us'

async function crmLogin(page: Page) {
  await page.goto(`${CRM}/login`)
  await page.fill('#email', 'qa-staff@tonydurante.us')
  await page.fill('#password', 'TDqastaff2026!')
  await page.click('button[type="submit"]')
  await page.waitForURL(`${CRM}/**`, { timeout: 15000 })
  await page.waitForTimeout(2000)
}

async function portalLogin(page: Page) {
  await page.goto(`${PORTAL}/portal/login`)
  await page.waitForTimeout(2000)
  if (!page.url().includes('/login')) return
  await page.fill('input[type="email"]', 'uxio74@gmail.com')
  await page.fill('input[type="password"]', 'TDz5q24tmg!')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(5000)
}

// ═══════════════════════════════════════════════════════════════
// CRM VISUAL REGRESSION
// ═══════════════════════════════════════════════════════════════

test.describe('CRM Visual Regression', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await crmLogin(page)
  })
  test.afterAll(async () => { await page.close() })

  const crmPages = [
    { path: '/', name: 'dashboard' },
    { path: '/accounts', name: 'accounts' },
    { path: '/tasks', name: 'tasks' },
    { path: '/payments', name: 'payments' },
    { path: '/tax-returns', name: 'tax-returns' },
    { path: '/trackers', name: 'trackers' },
    { path: '/inbox', name: 'inbox' },
    { path: '/calendar', name: 'calendar' },
    { path: '/invoice-settings', name: 'invoice-settings' },
  ]

  for (const { path, name } of crmPages) {
    test(`CRM ${name} matches visual baseline`, async () => {
      await page.goto(`${CRM}${path}`)
      await page.waitForTimeout(3000)
      // Wait for dynamic content to settle
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1000)

      await expect(page).toHaveScreenshot(`crm-${name}.png`, {
        fullPage: false, // Viewport only — full page screenshots are too noisy
        maxDiffPixelRatio: 0.08, // 8% tolerance for dynamic data (dates, counts)
      })
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// PORTAL VISUAL REGRESSION
// ═══════════════════════════════════════════════════════════════

test.describe('Portal Visual Regression', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await portalLogin(page)
  })
  test.afterAll(async () => { await page.close() })

  const portalPages = [
    { path: '/portal', name: 'dashboard' },
    { path: '/portal/services', name: 'services' },
    { path: '/portal/invoices', name: 'invoices' },
    { path: '/portal/documents', name: 'documents' },
    { path: '/portal/chat', name: 'chat' },
    { path: '/portal/profile', name: 'profile' },
    { path: '/portal/deadlines', name: 'deadlines' },
  ]

  for (const { path, name } of portalPages) {
    test(`Portal ${name} matches visual baseline`, async () => {
      await page.goto(`${PORTAL}${path}`)
      await page.waitForTimeout(3000)
      if (page.url().includes('/login')) {
        await portalLogin(page)
        await page.goto(`${PORTAL}${path}`)
        await page.waitForTimeout(3000)
      }
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1000)

      await expect(page).toHaveScreenshot(`portal-${name}.png`, {
        fullPage: false,
        maxDiffPixelRatio: 0.08,
      })
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// LOGIN PAGES VISUAL REGRESSION
// ═══════════════════════════════════════════════════════════════

test.describe('Login Visual Regression', () => {
  test('CRM login matches baseline', async ({ page }) => {
    await page.goto(`${CRM}/login`)
    await page.waitForTimeout(2000)
    await expect(page).toHaveScreenshot('crm-login.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('Portal login matches baseline', async ({ page }) => {
    await page.goto(`${PORTAL}/portal/login`)
    await page.waitForTimeout(2000)
    await expect(page).toHaveScreenshot('portal-login.png', {
      maxDiffPixelRatio: 0.05,
    })
  })
})
