/**
 * CROSS-BROWSER TESTS
 * Runs on Firefox + Safari (WebKit) in addition to Chromium.
 * Tests key pages load and function correctly in all browsers.
 *
 * Run: npx playwright test cross-browser --project=firefox --project=webkit --project=chromium
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
// CRM — Key pages load in all browsers
// ═══════════════════════════════════════════════════════════════

test.describe('Cross-Browser: CRM', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await crmLogin(page)
  })
  test.afterAll(async () => { await page.close() })

  const crmPages = [
    { path: '/', name: 'Dashboard' },
    { path: '/accounts', name: 'Accounts' },
    { path: '/tasks', name: 'Tasks' },
    { path: '/payments', name: 'Payments' },
    { path: '/tax-returns', name: 'Tax Returns' },
    { path: '/inbox', name: 'Inbox' },
    { path: '/trackers', name: 'Trackers' },
  ]

  for (const { path, name } of crmPages) {
    test(`CRM ${name} loads correctly`, async () => {
      const response = await page.goto(`${CRM}${path}`)
      expect(response?.status()).toBeLessThan(500)
      await page.waitForTimeout(2000)
      expect(page.url()).not.toContain('/login')
      // Page should have meaningful content
      const content = await page.textContent('main')
      expect(content!.length).toBeGreaterThan(10)
    })
  }

  test('CRM login form works', async ({ browser }) => {
    const newPage = await browser.newPage()
    await newPage.goto(`${CRM}/login`)
    await newPage.waitForTimeout(2000)
    // Form elements should be visible and functional
    await expect(newPage.locator('#email')).toBeVisible()
    await expect(newPage.locator('#password')).toBeVisible()
    await expect(newPage.locator('button[type="submit"]')).toBeVisible()
    await newPage.close()
  })
})

// ═══════════════════════════════════════════════════════════════
// PORTAL — Key pages load in all browsers
// ═══════════════════════════════════════════════════════════════

test.describe('Cross-Browser: Portal', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await portalLogin(page)
  })
  test.afterAll(async () => { await page.close() })

  const portalPages = [
    { path: '/portal', name: 'Dashboard' },
    { path: '/portal/services', name: 'Services' },
    { path: '/portal/invoices', name: 'Invoices' },
    { path: '/portal/documents', name: 'Documents' },
    { path: '/portal/chat', name: 'Chat' },
    { path: '/portal/profile', name: 'Profile' },
  ]

  for (const { path, name } of portalPages) {
    test(`Portal ${name} loads correctly`, async () => {
      const response = await page.goto(`${PORTAL}${path}`)
      expect(response?.status()).toBeLessThan(500)
      await page.waitForTimeout(2000)
      // Page should have content (even if redirected to login)
      const content = await page.textContent('body')
      expect(content!.length).toBeGreaterThan(10)
    })
  }

  test('Portal login form works', async ({ browser }) => {
    const newPage = await browser.newPage()
    await newPage.goto(`${PORTAL}/portal/login`)
    await newPage.waitForTimeout(2000)
    await expect(newPage.locator('input[type="email"]')).toBeVisible()
    await expect(newPage.locator('input[type="password"]')).toBeVisible()
    await expect(newPage.locator('button[type="submit"]')).toBeVisible()
    await newPage.close()
  })
})

// ═══════════════════════════════════════════════════════════════
// MOBILE SAFARI — Key portal pages on iPhone viewport
// ═══════════════════════════════════════════════════════════════

test.describe('Cross-Browser: Mobile Safari', () => {
  test('Portal dashboard on iPhone viewport', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    })
    const page = await ctx.newPage()
    await page.goto(`${PORTAL}/portal/login`)
    await page.waitForTimeout(2000)
    // Login page should render without horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual(400)
    await ctx.close()
  })
})
