import { test, expect, type Page } from '@playwright/test'

const BASE = 'https://portal.tonydurante.us'
const EMAIL = 'housedurante@icloud.com'
const PASSWORD = 'TDz5q24tmg!'

async function login(page: Page) {
  await page.goto(`${BASE}/portal/login`)
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForURL(`${BASE}/portal`, { timeout: 15000 })
}

test.describe.serial('Portal — Lead Tier', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('Dashboard shows welcome banner', async () => {
    await page.goto(`${BASE}/portal`)
    await expect(page.getByText(/Welcome/i)).toBeVisible({ timeout: 15000 })
  })

  test('Dashboard shows progress tracker', async () => {
    await expect(page.getByText('YOUR PROGRESS')).toBeVisible()
    await expect(page.getByText('Review Proposal')).toBeVisible()
    await expect(page.getByText('Sign Contract')).toBeVisible()
    await expect(page.getByText('Make Payment')).toBeVisible()
    await expect(page.getByText('Complete Setup')).toBeVisible()
  })

  test('Dashboard shows services from offer', async () => {
    await expect(page.getByText('SERVICES INCLUDED')).toBeVisible()
    await expect(page.getByText('LLC Onboarding & Management')).toBeVisible()
    await expect(page.getByText('ITIN Application')).toBeVisible()
  })

  test('Sidebar hides billing/invoices for lead tier', async () => {
    const sidebar = page.locator('aside')
    await expect(sidebar.getByText('Dashboard')).toBeVisible()
    await expect(sidebar.getByText('Your Proposal')).toBeVisible()
    await expect(sidebar.getByText('Chat')).toBeVisible()
    await expect(sidebar.getByText('Billing')).not.toBeVisible()
    await expect(sidebar.getByText('Invoices')).not.toBeVisible()
  })

  test('Company switcher shows client name', async () => {
    await expect(page.getByText('Uxio Lead Test')).toBeVisible()
  })

  test('Offer page loads', async () => {
    await page.goto(`${BASE}/portal/offer`)
    // Status bar text depends on offer status — any of these is valid
    await expect(
      page.getByText('Proposal Ready')
        .or(page.getByText('Proposta Pronta'))
        .or(page.getByText('In Revisione'))
        .or(page.getByText('Under Review'))
        .or(page.getByText('Offerta Consulenziale'))
    ).toBeVisible({ timeout: 15000 })
  })

  test('Chat page loads for lead', async () => {
    await page.goto(`${BASE}/portal/chat`)
    await page.waitForTimeout(3000)
    expect(page.url()).toContain('/portal/chat')
  })

  test('Documents page shows empty state', async () => {
    await page.goto(`${BASE}/portal/documents`)
    await page.waitForTimeout(3000)
    expect(page.url()).toContain('/portal/documents')
    await expect(page.getByText('Documents will appear here')).toBeVisible({ timeout: 10000 })
  })
})

test('Login page has privacy links', async ({ browser }) => {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  await p.goto(`${BASE}/portal/login`)
  await expect(p.getByRole('link', { name: 'Privacy Policy' })).toBeVisible()
  await expect(p.getByRole('link', { name: 'Cookie Policy' })).toBeVisible()
  await expect(p.getByRole('link', { name: 'Terms' })).toBeVisible()
  await ctx.close()
})
