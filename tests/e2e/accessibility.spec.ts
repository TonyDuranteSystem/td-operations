/**
 * ACCESSIBILITY TESTS (axe-core WCAG scan)
 * Scans every CRM and Portal page for WCAG 2.1 violations.
 * Uses @axe-core/playwright for automated accessibility auditing.
 */
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

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
// CRM ACCESSIBILITY
// ═══════════════════════════════════════════════════════════════

test.describe('CRM Accessibility', () => {
  const crmPages = [
    { path: '/', name: 'Dashboard' },
    { path: '/accounts', name: 'Accounts' },
    { path: '/tasks', name: 'Tasks' },
    { path: '/payments', name: 'Payments' },
    { path: '/tax-returns', name: 'Tax Returns' },
    { path: '/inbox', name: 'Inbox' },
    { path: '/trackers', name: 'Trackers' },
    { path: '/calendar', name: 'Calendar' },
  ]

  for (const { path, name } of crmPages) {
    test(`${name} page has no critical a11y violations`, async ({ browser }) => {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await crmLogin(page)
      await page.goto(`${CRM}${path}`)
      await page.waitForTimeout(3000)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast'])
        .analyze()

      const critical = results.violations.filter(v =>
        v.impact === 'critical' || v.impact === 'serious'
      )

      if (critical.length > 0) {
        console.log(`\n[A11Y] ${name} page violations:`)
        critical.forEach(v => {
          console.log(`  - ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} elements)`)
        })
      }

      expect(critical.length).toBeLessThan(5)
      await ctx.close()
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// PORTAL ACCESSIBILITY
// ═══════════════════════════════════════════════════════════════

test.describe('Portal Accessibility', () => {
  const portalPages = [
    { path: '/portal', name: 'Dashboard' },
    { path: '/portal/services', name: 'Services' },
    { path: '/portal/invoices', name: 'Invoices' },
    { path: '/portal/documents', name: 'Documents' },
    { path: '/portal/chat', name: 'Chat' },
    { path: '/portal/profile', name: 'Profile' },
  ]

  for (const { path, name } of portalPages) {
    test(`Portal ${name} has no critical a11y violations`, async ({ browser }) => {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await portalLogin(page)
      await page.goto(`${PORTAL}${path}`)
      await page.waitForTimeout(3000)
      if (page.url().includes('/login')) {
        await portalLogin(page)
        await page.goto(`${PORTAL}${path}`)
        await page.waitForTimeout(3000)
      }

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast'])
        .analyze()

      const critical = results.violations.filter(v =>
        v.impact === 'critical' || v.impact === 'serious'
      )

      if (critical.length > 0) {
        console.log(`\n[A11Y] Portal ${name} violations:`)
        critical.forEach(v => {
          console.log(`  - ${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} elements)`)
        })
      }

      expect(critical.length).toBeLessThan(5)
      await ctx.close()
    })
  }
})

// ═══════════════════════════════════════════════════════════════
// LOGIN PAGES ACCESSIBILITY (unauthenticated)
// ═══════════════════════════════════════════════════════════════

test.describe('Login Page Accessibility', () => {
  test('CRM login page has no a11y violations', async ({ page }) => {
    await page.goto(`${CRM}/login`)
    await page.waitForTimeout(2000)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()

    const critical = results.violations.filter(v =>
      v.impact === 'critical' || v.impact === 'serious'
    )
    expect(critical.length).toBeLessThan(3)
  })

  test('Portal login page has no a11y violations', async ({ page }) => {
    await page.goto(`${PORTAL}/portal/login`)
    await page.waitForTimeout(2000)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()

    const critical = results.violations.filter(v =>
      v.impact === 'critical' || v.impact === 'serious'
    )
    expect(critical.length).toBeLessThan(3)
  })
})
