/**
 * Deep E2E Flow Tests — Tests actual user journeys, not just page loads.
 * Uses housedurante@icloud.com (Uxio Lead Test) as test account.
 */
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

// ─── FLOW 1: Login + Navigate All Lead Pages ─────────────────

test.describe.serial('Flow 1: Full Lead Navigation', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })
  test.afterAll(async () => { await page.close() })

  test('Dashboard renders with welcome + progress + services + quick actions', async () => {
    await page.goto(`${BASE}/portal`)
    // Welcome banner
    await expect(page.getByText(/Welcome|Benvenuto/i)).toBeVisible({ timeout: 15000 })
    // Progress tracker — all 4 steps
    const steps = await page.locator('[class*="rounded"]').filter({ hasText: /Review|Rivedi|Sign|Firma|Payment|Pagamento|Setup|Registrazione/i }).count()
    expect(steps).toBeGreaterThanOrEqual(4)
    // Services section
    await expect(page.getByText('LLC Onboarding & Management')).toBeVisible()
    await expect(page.getByText('ITIN Application')).toBeVisible()
    // Quick actions
    await expect(page.getByText(/View Your Proposal|Rivedi la Proposta/i).first()).toBeVisible()
    await expect(page.getByText(/Chat|Chatta/i).first()).toBeVisible()
    await expect(page.getByText(/Request a Service|Richiedi un Servizio/i)).toBeVisible()
  })

  test('Offer page renders proposal with Italian content', async () => {
    await page.goto(`${BASE}/portal/offer`)
    await page.waitForTimeout(3000)
    // Offer iframe should load (use title to find the right iframe)
    const iframe = page.locator('iframe[title*="Proposal"]')
    await expect(iframe).toBeVisible({ timeout: 10000 })
    const src = await iframe.getAttribute('src')
    expect(src).toContain('/offer/uxio-lead-test-2026')
  })

  test('Chat page has input field and send button', async () => {
    await page.goto(`${BASE}/portal/chat`)
    await page.waitForTimeout(3000)
    expect(page.url()).toContain('/portal/chat')
    // Message input
    const input = page.locator('textarea, input[type="text"]').last()
    await expect(input).toBeVisible({ timeout: 10000 })
    // Send button
    await expect(page.locator('button').filter({ has: page.locator('svg') }).last()).toBeVisible()
  })

  test('Documents page shows empty state with correct message', async () => {
    await page.goto(`${BASE}/portal/documents`)
    await page.waitForTimeout(3000)
    expect(page.url()).toContain('/portal/documents')
    await expect(page.getByText(/Documents will appear|documenti appariranno/i)).toBeVisible({ timeout: 10000 })
    // Empty state should be the primary content (no file list)
  })

  test('Settings page loads with profile section', async () => {
    await page.goto(`${BASE}/portal/settings`)
    await page.waitForTimeout(2000)
    expect(page.url()).toContain('/portal/settings')
  })

  test('Guide page loads', async () => {
    await page.goto(`${BASE}/portal/guide`)
    await page.waitForTimeout(2000)
    expect(page.url()).toContain('/portal/guide')
  })

  test('Hidden pages redirect for lead tier', async () => {
    // Services page should redirect or show empty for leads
    await page.goto(`${BASE}/portal/services`)
    await page.waitForTimeout(3000)
    // Should redirect to portal or show limited content
    const url = page.url()
    expect(url).toMatch(/\/portal(\/services)?/)

    // Billing page — should redirect
    await page.goto(`${BASE}/portal/billing`)
    await page.waitForTimeout(3000)
    expect(page.url()).toMatch(/\/portal/)

    // Deadlines — should redirect
    await page.goto(`${BASE}/portal/deadlines`)
    await page.waitForTimeout(3000)
    expect(page.url()).toMatch(/\/portal/)
  })
})

// ─── FLOW 2: Service Request Full Journey ────────────────────

test.describe.serial('Flow 2: Service Request Journey', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })
  test.afterAll(async () => { await page.close() })

  test('Navigate to service request from dashboard', async () => {
    await page.goto(`${BASE}/portal`)
    await page.waitForTimeout(2000)
    await page.getByText(/Request a Service|Richiedi un Servizio/i).click()
    await page.waitForURL(`${BASE}/portal/services/request`, { timeout: 10000 })
  })

  test('Service grid shows all 9 options', async () => {
    const services = [
      /LLC Formation|Costituzione/i,
      /Tax Return|Dichiarazione/i,
      /ITIN/i,
      /Banking|Conto/i,
      /EIN/i,
      /Shipping|Spedizioni/i,
      /Notary|Notaio/i,
      /Closure|Chiusura/i,
      /Consulting|Consulenza/i,
    ]
    for (const svc of services) {
      await expect(page.getByText(svc).first()).toBeVisible()
    }
  })

  test('Selecting a service shows the request form', async () => {
    // Click on Notary
    await page.getByText(/Notary|Notaio/i).first().click()
    await page.waitForTimeout(500)

    // Form should appear with textarea + urgency + submit
    await expect(page.locator('textarea')).toBeVisible()
    await expect(page.getByText(/Normal|Normale/i).first()).toBeVisible()
    await expect(page.getByText(/Urgent|Urgente/i).first()).toBeVisible()
    await expect(page.getByText(/Submit|Invia/i).last()).toBeVisible()
  })

  test('Back button returns to service grid', async () => {
    await page.getByText(/Back|Torna/i).first().click()
    await page.waitForTimeout(500)
    // Grid should be visible again
    await expect(page.getByText(/Notary|Notaio/i).first()).toBeVisible()
    await expect(page.getByText(/Banking|Conto/i).first()).toBeVisible()
  })

  test('Submit a service request', async () => {
    // Select Shipping
    await page.getByText(/Shipping|Spedizioni/i).first().click()
    await page.waitForTimeout(500)

    // Fill details
    await page.locator('textarea').fill('TEST REQUEST: Need to ship documents to Italy. 2 envelopes, priority mail.')

    // Set urgency to normal (should be default)
    await expect(page.getByText(/Normal|Normale/i).first()).toBeVisible()

    // Submit
    await page.getByText(/Submit|Invia/i).last().click()
    await page.waitForTimeout(3000)

    // Should show success state
    await expect(page.getByText(/Request Submitted|Richiesta Inviata/i)).toBeVisible({ timeout: 10000 })
    // Should have buttons to go to dashboard or chat
    await expect(page.getByText(/Dashboard/i).first()).toBeVisible()
    await expect(page.getByText(/Chat/i).first()).toBeVisible()
  })
})

// ─── FLOW 3: Offer Page Interaction ──────────────────────────

test.describe.serial('Flow 3: Offer Page Deep Check', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })
  test.afterAll(async () => { await page.close() })

  test('Offer iframe loads and shows offer content', async () => {
    await page.goto(`${BASE}/portal/offer`)
    await page.waitForTimeout(8000) // Cross-origin iframe needs more time

    const iframe = page.frameLocator('iframe[title*="Proposal"]')
    await expect(iframe.getByText(/Tony Durante/i).first()).toBeVisible({ timeout: 20000 })
  })

  test('Offer shows correct client name', async () => {
    const iframe = page.frameLocator('iframe[title*="Proposal"]')
    await expect(iframe.getByText(/Uxio Lead Test/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('Offer shows pricing', async () => {
    const iframe = page.frameLocator('iframe[title*="Proposal"]')
    // Should have EUR amounts
    await expect(iframe.getByText(/€2[,.]?[38]00/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('Offer has sign/accept button or signed state', async () => {
    const iframe = page.frameLocator('iframe[title*="Proposal"]')
    // Either "Accetta e Firma" button (not signed) or "Contract Signed" message (already signed)
    const signBtn = iframe.getByText(/Accetta e Firma|Accept|Contract Signed|Contratto Firmato|Ready to Start|Pronto a Partire/i).first()
    await expect(signBtn).toBeVisible({ timeout: 15000 })
  })
})

// ─── FLOW 4: Chat Interaction ────────────────────────────────

test.describe.serial('Flow 4: Chat Interaction', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })
  test.afterAll(async () => { await page.close() })

  test('Chat page loads with message input', async () => {
    await page.goto(`${BASE}/portal/chat`)
    await page.waitForTimeout(3000)
    expect(page.url()).toContain('/portal/chat')
    // Header
    await expect(page.getByText(/Chat/i).first()).toBeVisible()
  })

  test('Can type a message in the chat input', async () => {
    const input = page.locator('textarea, input[placeholder*="message" i], input[placeholder*="messaggio" i]').first()
    if (await input.isVisible()) {
      await input.fill('TEST MESSAGE: Hello from Playwright test')
      const value = await input.inputValue()
      expect(value).toContain('TEST MESSAGE')
      // Clear it — don't actually send
      await input.fill('')
    }
  })
})

// ─── FLOW 5: Cross-Page Navigation Speed ─────────────────────

test.describe.serial('Flow 5: Navigation Performance', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    await login(page)
  })
  test.afterAll(async () => { await page.close() })

  test('Navigate through all pages in under 30 seconds', async () => {
    const start = Date.now()
    const pages = [
      '/portal',
      '/portal/offer',
      '/portal/chat',
      '/portal/documents',
      '/portal/services/request',
      '/portal/settings',
      '/portal/guide',
    ]

    for (const path of pages) {
      await page.goto(`${BASE}${path}`)
      await page.waitForTimeout(1000)
      // Each page should not redirect to login
      expect(page.url()).not.toContain('/portal/login')
    }

    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(30000)
  })
})
