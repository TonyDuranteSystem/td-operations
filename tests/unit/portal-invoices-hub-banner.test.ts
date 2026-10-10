/**
 * The big green callout hanging under the "Customers & Invoices" menu item + the menu position
 * (Antonio 2026-10-09, dev job 1a23f5f1). It replaced a banner on the home page.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { t } from '@/lib/portal/i18n'

const callout = readFileSync('components/portal/invoices-menu-callout.tsx', 'utf8')
const home = readFileSync('app/portal/page.tsx', 'utf8')
const side = readFileSync('components/portal/portal-sidebar.tsx', 'utf8')

describe('callout under the invoices menu item', () => {
  it('is drawn under the invoices row only while the NEW state is on (hub on, not a teammate, not yet opened)', () => {
    expect(side).toMatch(/if \(item\.key === 'nav\.invoices' && showInvoicesNew\) \{[\s\S]*<InvoicesMenuCallout/)
  })
  it('clears the memory on open or close, and only Open closes the phone drawer', () => {
    const dismiss = side.match(/onDismiss=\{\(\) => \{([\s\S]*?)\n            \}\}/)?.[1] ?? ''
    expect(dismiss).toContain('setShowInvoicesNew(false)')
    expect(dismiss).toContain("localStorage.setItem(INVOICES_NEW_KEY, '1')")
    expect(dismiss).not.toContain('setMobileOpen')
    expect(side).toMatch(/onOpen=\{\(\) => \{[\s\S]*setMobileOpen\(false\)/)
    expect(callout).toContain('href="/portal/invoices"')
  })
  it('is remembered per company, and the TD Billing redirect (tab=expenses) does not count as seen', () => {
    expect(side).toMatch(/td-invoices-hub-new-v2:\$\{selectedAccountId\}/)
    expect(side).toContain("pathname.startsWith('/portal/invoices') && searchParams.get('tab') !== 'expenses'")
  })
  it('hides before it writes storage so a storage failure cannot leave it showing', () => {
    expect(side).toMatch(/setShowInvoicesNew\(false\)\s*window\.localStorage\.setItem\(INVOICES_NEW_KEY, '1'\)/)
  })
  it('is green, only the outline blinks (text stays readable), and only when motion is allowed', () => {
    expect(callout).toContain('border-emerald-500')
    expect(callout).toContain('ring-emerald-400/60 motion-safe:animate-pulse')
    expect(callout).not.toMatch(/className="relative[^"]*animate-pulse/)
  })
  it('has English and Italian text', () => {
    expect(t('nav.invoicesCallout.title', 'en')).toBe('New: Customers & Invoices')
    expect(t('nav.invoicesCallout.title', 'it')).toBe('Novità: Clienti e Fatture')
    expect(t('nav.invoicesCallout.cta', 'it')).toBe('Aprila')
  })
  it('the old home-page banner is gone', () => {
    expect(existsSync('components/portal/invoices-hub-banner.tsx')).toBe(false)
    expect(home).not.toContain('InvoicesHubBanner')
  })
})

describe('menu position', () => {
  it('moves the item right under Overview only when the new screen is on and not for teammates', () => {
    expect(side).toMatch(/if \(isTeammate \|\| !navVisibility\?\.invoiceHub\) return filteredCompanyItems/)
    expect(side).toMatch(/rest\.splice\(at \+ 1, 0, inv\)/)
  })
})
