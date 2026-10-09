/**
 * Home-page banner + menu position for "Customers & Invoices" (Antonio 2026-10-09, dev job 1a23f5f1).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const banner = readFileSync('components/portal/invoices-hub-banner.tsx', 'utf8')
const home = readFileSync('app/portal/page.tsx', 'utf8')
const side = readFileSync('components/portal/portal-sidebar.tsx', 'utf8')

describe('invoices hub banner on the portal home', () => {
  it('is rendered only for account admins of companies the new screen is on for', () => {
    expect(home).toMatch(/showInvoicesHubBanner = canManageTeam && isInvoiceHubOnFor\(await getInvoiceHubSetting\(\), selectedAccountId\)/)
    expect(home).toMatch(/\{showInvoicesHubBanner && <InvoicesHubBanner locale=\{locale\} \/>\}/)
  })
  it('shares its memory with the menu tag, links to invoices, and clears on open or close', () => {
    expect(banner).toContain("'td-invoices-hub-new-v1'")
    expect(banner).toContain('href="/portal/invoices"')
    expect(banner.match(/onClick=\{clear\}/g)?.length).toBe(2)
  })
  it('is green, blinks only when motion is allowed, and has English and Italian text', () => {
    expect(banner).toContain('motion-safe:animate-pulse')
    expect(banner).toContain('Clienti e Fatture')
    expect(banner).toContain('Customers & Invoices')
  })
})

describe('menu position', () => {
  it('moves the item right under Overview only when the new screen is on and not for teammates', () => {
    expect(side).toMatch(/if \(isTeammate \|\| !navVisibility\?\.invoiceHub\) return filteredCompanyItems/)
    expect(side).toMatch(/rest\.splice\(at \+ 1, 0, inv\)/)
  })
})
