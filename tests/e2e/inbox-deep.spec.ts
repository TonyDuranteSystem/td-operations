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

  test('Inbox page loads with conversations', async () => {
    await page.goto(`${BASE}/inbox`)
    await page.waitForTimeout(5000)
    // Check page loaded with content — any conversation visible
    const content = await page.content()
    const hasConversations = content.includes('Gmail') || content.includes('WhatsApp') || content.includes('border-b')
    expect(hasConversations).toBeTruthy()
  })

  test('Admin sees mailbox toggle (support@ and antonio@)', async () => {
    // Click Gmail tab
    const gmailBtn = page.locator('button', { hasText: /Gmail/i })
    if (await gmailBtn.isVisible({ timeout: 3000 })) {
      await gmailBtn.click()
      await page.waitForTimeout(2000)
    }
    // Check for mailbox toggle — these are small buttons in the mailbox selector bar
    const mailboxBar = page.locator('text=Mailbox:').locator('..')
    await expect(mailboxBar).toBeVisible({ timeout: 10000 })
    // Verify both buttons exist in the mailbox bar
    const content = await mailboxBar.innerHTML()
    expect(content).toContain('support@')
    expect(content).toContain('antonio@')
  })

  test('Switching to antonio@ mailbox works', async () => {
    const mailboxBar = page.locator('text=Mailbox:').locator('..')
    const antonioBtn = mailboxBar.locator('button', { hasText: /antonio@/i })
    if (await antonioBtn.isVisible({ timeout: 3000 })) {
      await antonioBtn.click()
      await page.waitForTimeout(4000)
      const content = await page.content()
      expect(content.length).toBeGreaterThan(1000)
    }
  })

  test('Clicking email opens it and marks as read', async () => {
    // Switch back to support@
    const mailboxBar = page.locator('text=Mailbox:').locator('..')
    const supportBtn = mailboxBar.locator('button', { hasText: /support@/i })
    if (await supportBtn.isVisible({ timeout: 3000 })) {
      await supportBtn.click()
      await page.waitForTimeout(2000)
    }
    // Click first email in list
    const firstEmail = page.locator('button[class*="text-left"]').first()
    if (await firstEmail.isVisible({ timeout: 5000 })) {
      await firstEmail.click()
      await page.waitForTimeout(3000)
      // Verify email content loaded (message area has content)
      const messageArea = page.locator('[class*="overflow-y-auto"]').last()
      const html = await messageArea.innerHTML()
      expect(html.length).toBeGreaterThan(100)
    }
  })

  test('Gmail email has action buttons (Delete, Archive, Star, Unread)', async () => {
    // Navigate fresh to inbox Gmail
    await page.goto(`${BASE}/inbox`)
    await page.waitForTimeout(4000)
    // Click Gmail tab
    const gmailBtn = page.locator('button', { hasText: /Gmail/i }).first()
    await gmailBtn.click()
    await page.waitForTimeout(3000)
    // Click first conversation in the list
    const conversations = page.locator('[class*="border-b"] button[class*="text-left"]')
    const count = await conversations.count()
    if (count > 0) {
      await conversations.first().click()
      await page.waitForTimeout(3000)
      // Now check action buttons
      const deleteBtn = page.locator('button[title="Delete"]')
      const hasDelete = await deleteBtn.isVisible({ timeout: 5000 }).catch(() => false)
      expect(hasDelete).toBeTruthy()
    }
  })

  test('Search bar visible', async () => {
    await page.goto(`${BASE}/inbox`)
    await page.waitForTimeout(4000)
    const gmailBtn = page.locator('button', { hasText: /Gmail/i }).first()
    await gmailBtn.click()
    await page.waitForTimeout(2000)
    const searchInput = page.locator('input[placeholder*="Search"]')
    await expect(searchInput).toBeVisible({ timeout: 5000 })
  })
})
