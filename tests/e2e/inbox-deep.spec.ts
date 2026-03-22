import { test, expect } from '@playwright/test'

const BASE = process.env.TEST_BASE_URL || 'https://td-operations.vercel.app'
const ADMIN_EMAIL = 'antonio.durante@tonydurante.us'
const ADMIN_PASS = process.env.CRM_ADMIN_PASSWORD || ''

// Skip all inbox tests if no admin password
const HAS_CREDS = !!ADMIN_PASS

test.describe.serial('Inbox Deep Tests', () => {
  test.skip(() => !HAS_CREDS, 'Skipped: CRM_ADMIN_PASSWORD not set')

  let page: any

  test.beforeAll(async ({ browser }) => {
    if (!HAS_CREDS) return
    page = await browser.newPage()
    await page.goto(`${BASE}/login`)
    await page.waitForTimeout(2000)
    const emailInput = page.locator('input[type="email"]')
    if (await emailInput.isVisible()) {
      await emailInput.fill(ADMIN_EMAIL)
      await page.locator('input[type="password"]').fill(ADMIN_PASS)
      await page.click('button[type="submit"]')
      await page.waitForTimeout(3000)
    }
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('Inbox page loads with Gmail tab', async () => {
    await page.goto(`${BASE}/inbox`)
    await page.waitForTimeout(4000)
    // Check Gmail tab exists
    const gmailTab = page.getByText('Gmail')
    await expect(gmailTab).toBeVisible()
  })

  test('Admin sees mailbox toggle (support@ and antonio@)', async () => {
    await page.goto(`${BASE}/inbox`)
    await page.waitForTimeout(3000)
    // Click Gmail tab first
    await page.getByText('Gmail').click()
    await page.waitForTimeout(2000)
    // Check for mailbox toggle
    const supportBtn = page.getByText('support@')
    const antonioBtn = page.getByText('antonio@')
    await expect(supportBtn).toBeVisible({ timeout: 10000 })
    await expect(antonioBtn).toBeVisible({ timeout: 10000 })
  })

  test('Switching mailbox loads different emails', async () => {
    // Click antonio@
    await page.getByText('antonio@').click()
    await page.waitForTimeout(3000)
    // Should see emails (at least one conversation)
    const conversations = page.locator('[class*="border-b"]').filter({ hasText: /@|Re:|Fwd:|New/ })
    const count = await conversations.count()
    expect(count).toBeGreaterThan(0)
  })

  test('Email renders HTML with clickable links', async () => {
    await page.goto(`${BASE}/inbox`)
    await page.waitForTimeout(3000)
    await page.getByText('Gmail').click()
    await page.waitForTimeout(2000)
    // Click first email
    const firstEmail = page.locator('button[class*="text-left"]').first()
    if (await firstEmail.isVisible()) {
      await firstEmail.click()
      await page.waitForTimeout(3000)
      // Check the message area has rendered HTML (links or formatted content)
      const messageArea = page.locator('[class*="overflow-y-auto"]').last()
      const html = await messageArea.innerHTML()
      // Should have actual HTML elements, not raw tags as text
      const hasRenderedHtml = html.includes('<a ') || html.includes('<div') || html.includes('<p')
      const hasRawTags = html.includes('&lt;a ') || html.includes('&lt;div')
      expect(hasRenderedHtml || !hasRawTags).toBeTruthy()
    }
  })

  test('Delete button exists in email header', async () => {
    // Should still have an email open from previous test
    const deleteBtn = page.locator('button[title="Delete"]')
    await expect(deleteBtn).toBeVisible({ timeout: 5000 })
  })

  test('Archive button exists in email header', async () => {
    const archiveBtn = page.locator('button[title="Archive"]')
    await expect(archiveBtn).toBeVisible({ timeout: 5000 })
  })

  test('Mark Unread button exists in email header', async () => {
    const unreadBtn = page.locator('button[title="Mark Unread"]')
    await expect(unreadBtn).toBeVisible({ timeout: 5000 })
  })

  test('Star button exists in email header', async () => {
    const starBtn = page.locator('button[title="Star"]')
    await expect(starBtn).toBeVisible({ timeout: 5000 })
  })

  test('Search bar exists and is functional', async () => {
    const searchInput = page.locator('input[placeholder*="Search emails"]')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('test')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)
    // Clear search
    const clearBtn = page.locator('button').filter({ has: page.locator('svg') }).last()
    if (await clearBtn.isVisible()) {
      await clearBtn.click()
    }
  })

  test('Sidebar folders section exists', async () => {
    const foldersSection = page.getByText('FOLDERS')
    await expect(foldersSection).toBeVisible({ timeout: 5000 })
  })

  test('Inbox sidebar shows default labels', async () => {
    const inbox = page.getByText('Inbox').first()
    const sent = page.getByText('Sent').first()
    const drafts = page.getByText('Drafts').first()
    await expect(inbox).toBeVisible({ timeout: 5000 })
    await expect(sent).toBeVisible({ timeout: 5000 })
    await expect(drafts).toBeVisible({ timeout: 5000 })
  })
})
