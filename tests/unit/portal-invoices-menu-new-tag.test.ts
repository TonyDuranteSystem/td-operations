/**
 * The green blinking "NEW" tag on the "Customers & Invoices" menu item (Antonio 2026-10-09, dev job 1a23f5f1).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { t } from '@/lib/portal/i18n'

const side = readFileSync('components/portal/portal-sidebar.tsx', 'utf8')

describe('menu tag for Customers & Invoices', () => {
  it('only companies that have the new screen (and not teammates) get the tag', () => {
    expect(side).toMatch(/const invoicesHubOn = !isTeammate && !!navVisibility\?\.invoiceHub/)
    expect(side).toMatch(/setShowInvoicesNew\(invoicesHubOn && !onPage && !window\.localStorage\.getItem\(INVOICES_NEW_KEY\)\)/)
  })
  it('it is shown on the invoices menu item, in green, and blinks only when the device allows motion', () => {
    expect(side).toMatch(/item\.key === 'nav\.invoices' && showInvoicesNew && \(\s*<span\s+data-testid="invoices-new-tag"/)
    expect(side).toContain('bg-emerald-600')
    expect(side).toMatch(/\(item\.key === 'nav\.invoices' && showInvoicesNew\)\) && 'motion-safe:animate-pulse'/)
  })
  it('it goes away when the person opens the invoices page or clicks the item', () => {
    expect(side).toMatch(/pathname\.startsWith\('\/portal\/invoices'\)/)
    expect(side).toMatch(/if \(item\.key === 'nav\.invoices' && showInvoicesNew\) \{\s*try \{ localStorage\.setItem\(INVOICES_NEW_KEY, '1'\)/)
  })
  it('the word exists in English and Italian', () => {
    expect(t('nav.newBadge', 'en')).toBe('NEW')
    expect(t('nav.newBadge', 'it')).toBe('NUOVO')
  })
})
