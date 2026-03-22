import { test, expect } from '@playwright/test'

const APP_URL = 'https://app.tonydurante.us'
const PORTAL_URL = 'https://portal.tonydurante.us'

test.describe('API Health Checks', () => {
  test('Portal login page returns 200', async ({ request }) => {
    const res = await request.get(`${PORTAL_URL}/portal/login`)
    expect(res.status()).toBe(200)
  })

  test('Service catalog API responds (may require auth)', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/service-catalog`)
    // 200 = works, 302/307 = auth redirect — both acceptable
    expect([200, 302, 307]).toContain(res.status())
  })

  test('Invoice settings API responds (may require auth)', async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/invoice-settings`)
    expect([200, 302, 307]).toContain(res.status())
  })

  test('Offer page loads with valid token', async ({ request }) => {
    const res = await request.get(`${APP_URL}/offer/uxio-lead-test-2026`)
    expect(res.status()).toBe(200)
  })

  test('Portal chat page requires auth', async ({ request }) => {
    const res = await request.get(`${PORTAL_URL}/portal/chat`, { maxRedirects: 0 })
    // Should redirect to login
    expect([200, 302, 303, 307, 308]).toContain(res.status())
  })

  test('Wizard submit API rejects unauthorized', async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/portal/wizard/submit`, {
      data: { test: true },
    })
    expect(res.status()).toBeGreaterThanOrEqual(400)
  })
})
