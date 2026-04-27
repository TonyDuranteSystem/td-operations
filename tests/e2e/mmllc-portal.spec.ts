/**
 * MMLLC PORTAL E2E TESTS — Oh My Creatives LLC
 *
 * Member structure (sandbox):
 *   - Damiano Mocellin      individual, is_primary=true  (member_id: e3136bc0)
 *   - Acme Holdings LLC     company, rep: Marco Verdi    (member_id: af5bb04c)
 *   - Rossi Ventures LLC    company, rep: Giovanni Rossi (member_id: 0e6e5c88)
 *   - Bianchi Group LLC     company, rep: Maria Bianchi  (member_id: b08a96ee)
 *
 * Scenarios:
 *   A — Damiano: Orizzonti is default (is_primary sort), can switch to Oh My Creatives
 *   B — Oh My Creatives overview: 4 members visible on the members card
 *   C1/C2/C3 — Each company member detail page renders company card (name, EIN, rep)
 *   D — Damiano individual detail page renders person card
 *   E — Giovanni (rep of Rossi Ventures): sees only Oh My Creatives, NOT Orizzonti
 *   F — Maria (rep of Bianchi Group): sees only Oh My Creatives
 *   G — Marco Verdi (rep of Acme Holdings): sees Oh My Creatives
 *   H — Cross-account: Giovanni cannot access fake member or Orizzonti
 *
 * NOTE: A–D share a SINGLE Damiano browser context (one login) to avoid
 * Supabase auth rate limiting (10 sign-ins/min per IP).
 *
 * Runs against: http://localhost:3001 (dev server with .env.sandbox)
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test'

const BASE = 'http://localhost:3001'
const PW = 'TDqa-sandbox-2026!'

const ACCOUNTS = {
  orizzonti:    '3048a76f-6feb-49a9-9c10-6b2ed5347cac',
  ohMyCreatives: 'fb534d22-1b06-45ae-8cc6-6a3007f1a489',
}

const MEMBERS = {
  damiano: { id: 'e3136bc0-6b43-46a3-b6df-db80e16c4083', name: 'Damiano Mocellin' },
  acme:    { id: 'af5bb04c-abe5-4b30-b624-f27a0ffc63b2', company: 'Acme Holdings LLC',  rep: 'Marco Verdi',    repEmail: 'marco.verdi.test@tonydurante.us',    ein: '99-9999901' },
  rossi:   { id: '0e6e5c88-0874-42af-a130-d208b2900558', company: 'Rossi Ventures LLC', rep: 'Giovanni Rossi', repEmail: 'giovanni.rossi.test@tonydurante.us', ein: '88-8888801' },
  bianchi: { id: 'b08a96ee-a90c-41a3-aa82-d220aafec2dd', company: 'Bianchi Group LLC',  rep: 'Maria Bianchi',  repEmail: 'maria.bianchi.test@tonydurante.us',  ein: '77-7777701' },
}

const USERS = {
  damiano: 'info@orizzonti.us',
  giovanni: 'giovanni.rossi.test@tonydurante.us',
  maria: 'maria.bianchi.test@tonydurante.us',
  marco: 'marco.verdi.test@tonydurante.us',
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/portal/login`)
  await page.waitForLoadState('networkidle')
  if (!page.url().includes('/login')) return
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', PW)
  await page.click('button[type="submit"]')
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 30000 }).catch(() => {})
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)
  if (page.url().includes('/change-password')) {
    const inputs = page.locator('input[type="password"]')
    await inputs.nth(0).fill(PW)
    const second = inputs.nth(1)
    if (await second.isVisible({ timeout: 1000 }).catch(() => false)) await second.fill(PW)
    await page.click('button[type="submit"]')
    await page.waitForURL(url => !url.toString().includes('/change-password'), { timeout: 15000 }).catch(() => {})
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
  }
}

// ─── Damiano scenarios A/B/C1/C2/C3/D — ONE login, shared context ─────────────
// Consolidating all Damiano tests into a single serial block avoids the
// Supabase auth rate limit (10 sign-ins/min) that was causing multiple
// `browser.newContext()` + login() calls per run to fail.

test.describe.serial('Damiano — A/B/C1/C2/C3/D', () => {
  let ctx: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext()
    page = await ctx.newPage()
    await login(page, USERS.damiano)
  })

  test.afterAll(async () => { await ctx.close() })

  // ── Scenario A: Damiano multi-account ──────────────────────────────────────

  test('A1 — portal loads with Orizzonti as default account', async () => {
    expect(page.url()).toContain('/portal')
    expect(page.url()).not.toContain('/login')
    expect(await page.innerText('body')).toContain('Orizzonti')
  })

  test('A2 — Oh My Creatives LLC visible in account switcher dropdown', async () => {
    // Use dispatchEvent (JS-level click) — Playwright's pointer-based click() triggers
    // mousedown which fires the outside-click handler before the button's onClick,
    // keeping the dropdown closed. dispatchEvent fires only the click event.
    await page.locator('button:has-text("Orizzonti LLC")').first().dispatchEvent('click')
    await page.waitForTimeout(500)
    await expect(page.locator('text="Oh My Creatives LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('A3 — can switch to Oh My Creatives LLC', async () => {
    await page.locator('button:has-text("Oh My Creatives LLC")').first().dispatchEvent('click')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    expect(await page.innerText('body')).toContain('Oh My Creatives')
  })

  // ── Scenario B: Oh My Creatives members card ────────────────────────────────
  // At this point the account switcher already set the cookie via the click above.
  // We refresh to ensure the portal renders Oh My Creatives' dashboard.

  test('B1 — Oh My Creatives overview loaded after switch', async () => {
    await ctx.addCookies([{
      name: 'portal_account_id',
      value: ACCOUNTS.ohMyCreatives,
      domain: 'localhost',
      path: '/portal',
    }])
    await page.goto(`${BASE}/portal`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    expect(await page.innerText('body')).toContain('Oh My Creatives')
  })

  test('B2 — Damiano Mocellin listed as member', async () => {
    await expect(page.locator('text="Damiano Mocellin"').first()).toBeVisible({ timeout: 5000 })
  })

  test('B3 — Acme Holdings LLC listed', async () => {
    await expect(page.locator('text="Acme Holdings LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('B4 — Rossi Ventures LLC listed', async () => {
    await expect(page.locator('text="Rossi Ventures LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('B5 — Bianchi Group LLC listed', async () => {
    await expect(page.locator('text="Bianchi Group LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  // ── Scenario C1: Acme Holdings LLC detail page ──────────────────────────────

  test('C1a — Acme Holdings page loads (no 404)', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.acme.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    expect(await page.innerText('body')).not.toContain('404')
  })

  test('C1b — company name shown', async () => {
    await expect(page.locator('text="Acme Holdings LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('C1c — "Company Member" badge shown', async () => {
    await expect(page.locator('text="Company Member"').first()).toBeVisible({ timeout: 3000 })
  })

  test('C1d — EIN shown', async () => {
    await expect(page.locator(`text="${MEMBERS.acme.ein}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C1e — representative name shown', async () => {
    await expect(page.locator(`text="${MEMBERS.acme.rep}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C1f — representative email shown', async () => {
    await expect(page.locator(`text="${MEMBERS.acme.repEmail}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C1g — "Authorized Representative" section shown', async () => {
    await expect(page.locator('text="Authorized Representative"').first()).toBeVisible({ timeout: 3000 })
  })

  test('C1h — back link returns to portal overview', async () => {
    await page.click('text="Back to Overview"')
    await page.waitForURL(url => !url.toString().includes('/members'), { timeout: 10000 })
    expect(page.url()).toMatch(/\/portal\/?(\?.*)?$/)
  })

  // ── Scenario C2: Rossi Ventures LLC detail page ──────────────────────────────

  test('C2a — Rossi Ventures page loads (no 404)', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.rossi.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    expect(await page.innerText('body')).not.toContain('404')
  })

  test('C2b — company name shown', async () => {
    await expect(page.locator('text="Rossi Ventures LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('C2c — "Company Member" badge shown', async () => {
    await expect(page.locator('text="Company Member"').first()).toBeVisible({ timeout: 3000 })
  })

  test('C2d — EIN shown', async () => {
    await expect(page.locator(`text="${MEMBERS.rossi.ein}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C2e — Giovanni Rossi shown', async () => {
    await expect(page.locator(`text="${MEMBERS.rossi.rep}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C2f — Giovanni email shown', async () => {
    await expect(page.locator(`text="${MEMBERS.rossi.repEmail}"`).first()).toBeVisible({ timeout: 3000 })
  })

  // ── Scenario C3: Bianchi Group LLC detail page ──────────────────────────────

  test('C3a — Bianchi Group page loads (no 404)', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.bianchi.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    expect(await page.innerText('body')).not.toContain('404')
  })

  test('C3b — company name shown', async () => {
    await expect(page.locator('text="Bianchi Group LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('C3c — "Company Member" badge shown', async () => {
    await expect(page.locator('text="Company Member"').first()).toBeVisible({ timeout: 3000 })
  })

  test('C3d — EIN shown', async () => {
    await expect(page.locator(`text="${MEMBERS.bianchi.ein}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C3e — Maria Bianchi shown', async () => {
    await expect(page.locator(`text="${MEMBERS.bianchi.rep}"`).first()).toBeVisible({ timeout: 3000 })
  })

  test('C3f — Maria email shown', async () => {
    await expect(page.locator(`text="${MEMBERS.bianchi.repEmail}"`).first()).toBeVisible({ timeout: 3000 })
  })

  // ── Scenario D: Damiano individual detail page ──────────────────────────────

  test('D1 — Damiano detail page loads (no 404)', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.damiano.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    expect(await page.innerText('body')).not.toContain('404')
  })

  test('D2 — name shown', async () => {
    await expect(page.locator('text="Damiano Mocellin"').first()).toBeVisible({ timeout: 5000 })
  })

  test('D3 — "Contact Information" section shown', async () => {
    await expect(page.locator('text="Contact Information"').first()).toBeVisible({ timeout: 3000 })
  })

  test('D4 — email shown (info@orizzonti.us)', async () => {
    await expect(page.locator(`text="${USERS.damiano}"`).first()).toBeVisible({ timeout: 3000 })
  })
})

// ─── Scenario E: Giovanni sees only Oh My Creatives ───────────────────────────

test.describe.serial('E — Giovanni portal access', () => {
  let ctx: BrowserContext
  let page: Page
  test.beforeAll(async ({ browser }) => { ctx = await browser.newContext(); page = await ctx.newPage(); await login(page, USERS.giovanni) })
  test.afterAll(async () => { await ctx.close() })

  test('E1 — portal loads', async () => {
    expect(page.url()).toContain('/portal')
    expect(page.url()).not.toContain('/login')
  })

  test('E2 — Oh My Creatives LLC is visible', async () => {
    expect(await page.innerText('body')).toContain('Oh My Creatives')
  })

  test('E3 — Orizzonti LLC is NOT visible', async () => {
    expect(await page.innerText('body')).not.toContain('Orizzonti')
  })

  test('E4 — Giovanni can view Rossi Ventures LLC detail (same account)', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.rossi.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    const text = await page.innerText('body')
    expect(text).not.toContain('404')
    await expect(page.locator('text="Rossi Ventures LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('E5 — Giovanni can view Damiano detail (same account)', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.damiano.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    await expect(page.locator('text="Damiano Mocellin"').first()).toBeVisible({ timeout: 5000 })
  })
})

// ─── Scenario F: Maria sees only Oh My Creatives ──────────────────────────────

test.describe.serial('F — Maria portal access', () => {
  let ctx: BrowserContext
  let page: Page
  test.beforeAll(async ({ browser }) => { ctx = await browser.newContext(); page = await ctx.newPage(); await login(page, USERS.maria) })
  test.afterAll(async () => { await ctx.close() })

  test('F1 — portal loads', async () => {
    expect(page.url()).toContain('/portal')
    expect(page.url()).not.toContain('/login')
  })

  test('F2 — Oh My Creatives LLC is visible', async () => {
    expect(await page.innerText('body')).toContain('Oh My Creatives')
  })

  test('F3 — Orizzonti LLC is NOT visible', async () => {
    expect(await page.innerText('body')).not.toContain('Orizzonti')
  })

  test('F4 — Maria can view Bianchi Group LLC detail', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.bianchi.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    const text = await page.innerText('body')
    expect(text).not.toContain('404')
    await expect(page.locator('text="Bianchi Group LLC"').first()).toBeVisible({ timeout: 5000 })
  })

  test('F5 — Maria can see all 4 members in the overview', async () => {
    await page.goto(`${BASE}/portal`)
    await page.waitForLoadState('networkidle')
    const text = await page.innerText('body')
    expect(text).toContain('Acme Holdings')
    expect(text).toContain('Rossi Ventures')
    expect(text).toContain('Bianchi Group')
    expect(text).toContain('Damiano')
  })
})

// ─── Scenario G: Marco Verdi sees Oh My Creatives ─────────────────────────────

test.describe.serial('G — Marco Verdi portal access', () => {
  let ctx: BrowserContext
  let page: Page
  test.beforeAll(async ({ browser }) => { ctx = await browser.newContext(); page = await ctx.newPage(); await login(page, USERS.marco) })
  test.afterAll(async () => { await ctx.close() })

  test('G1 — portal loads', async () => {
    expect(page.url()).toContain('/portal')
    expect(page.url()).not.toContain('/login')
  })

  test('G2 — Oh My Creatives LLC is visible', async () => {
    expect(await page.innerText('body')).toContain('Oh My Creatives')
  })

  test('G3 — Marco can view Acme Holdings LLC detail', async () => {
    await page.goto(`${BASE}/portal/members/${MEMBERS.acme.id}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)
    const text = await page.innerText('body')
    expect(text).not.toContain('404')
    await expect(page.locator('text="Acme Holdings LLC"').first()).toBeVisible({ timeout: 5000 })
  })
})

// ─── Scenario H: Cross-account isolation ──────────────────────────────────────

test.describe.serial('H — Cross-account isolation', () => {
  let ctx: BrowserContext
  let page: Page
  test.beforeAll(async ({ browser }) => { ctx = await browser.newContext(); page = await ctx.newPage(); await login(page, USERS.giovanni) })
  test.afterAll(async () => { await ctx.close() })

  test('H1 — unknown member ID returns 404/not-found', async () => {
    await page.goto(`${BASE}/portal/members/00000000-0000-0000-0000-000000000000`)
    await page.waitForLoadState('networkidle')
    expect(await page.innerText('body')).toMatch(/not found|404|Page Not Found/i)
  })

  test('H2 — Giovanni cannot see Orizzonti LLC in account list', async () => {
    await page.goto(`${BASE}/portal`)
    await page.waitForLoadState('networkidle')
    expect(await page.innerText('body')).not.toContain('Orizzonti')
  })
})
