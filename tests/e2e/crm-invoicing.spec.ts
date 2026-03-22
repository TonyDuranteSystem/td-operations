import { test, expect } from '@playwright/test'

const CRM_URL = 'https://td-operations.vercel.app'

test.describe('CRM — Invoicing System', () => {
  test.beforeEach(async ({ page }) => {
    // CRM uses Supabase Auth — login
    await page.goto(`${CRM_URL}/login`)
    // If already logged in, should redirect
    await page.waitForTimeout(2000)
    if (page.url().includes('/login')) {
      // Need to login — skip if we can't
      test.skip(true, 'CRM login requires credentials')
    }
  })

  test('Payments page loads', async ({ page }) => {
    await page.goto(`${CRM_URL}/payments`)
    await expect(page.locator('text=Payment Tracker').or(page.locator('text=Overdue'))).toBeVisible({ timeout: 10000 })
  })

  test('Invoice Settings page loads', async ({ page }) => {
    await page.goto(`${CRM_URL}/invoice-settings`)
    await expect(page.locator('text=Invoice Settings').or(page.locator('text=Company Info'))).toBeVisible({ timeout: 10000 })
  })
})
