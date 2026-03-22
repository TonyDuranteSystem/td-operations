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

test.describe.serial('Portal — Feature Pages', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })

  test.afterAll(async () => {
    await page.close()
  })

  test('Service request page loads with 9 services', async () => {
    await page.goto(`${BASE}/portal/services/request`)
    await page.waitForTimeout(2000)
    // Should show service grid (at least some service names)
    await expect(page.getByText(/LLC Formation|Costituzione LLC/i).first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/Tax Return|Dichiarazione/i).first()).toBeVisible()
    await expect(page.getByText(/ITIN/i).first()).toBeVisible()
    await expect(page.getByText(/Banking|Conto/i).first()).toBeVisible()
    await expect(page.getByText(/Shipping|Spedizioni/i).first()).toBeVisible()
    await expect(page.getByText(/Notary|Notaio/i).first()).toBeVisible()
    await expect(page.getByText(/Closure|Chiusura/i).first()).toBeVisible()
    await expect(page.getByText(/Consulting|Consulenza/i).first()).toBeVisible()
  })

  test('Service request shows form after selecting a service', async () => {
    await page.goto(`${BASE}/portal/services/request`)
    await page.waitForTimeout(2000)
    // Click on Shipping service
    await page.getByText(/Shipping|Spedizioni/i).first().click()
    await page.waitForTimeout(1000)
    // Should show details textarea
    await expect(page.locator('textarea')).toBeVisible()
    // Should show urgency buttons
    await expect(page.getByText(/Normal|Normale/i).first()).toBeVisible()
    await expect(page.getByText(/Urgent|Urgente/i).first()).toBeVisible()
  })

  test('Dashboard has Request Service quick action', async () => {
    await page.goto(`${BASE}/portal`)
    await page.waitForTimeout(2000)
    await expect(page.getByText(/Request a Service|Richiedi un Servizio/i)).toBeVisible({ timeout: 10000 })
  })

  test('Settings page loads', async () => {
    await page.goto(`${BASE}/portal/settings`)
    await page.waitForTimeout(2000)
    // Should not redirect — URL should stay on settings
    expect(page.url()).toContain('/portal/settings')
  })

  test('Guide page loads', async () => {
    await page.goto(`${BASE}/portal/guide`)
    await page.waitForTimeout(2000)
    expect(page.url()).toContain('/portal/guide')
  })
})
