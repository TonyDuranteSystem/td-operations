import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BankReferralsPanel, type BankReferralEntry } from '@/components/accounts/bank-referrals-panel'

const entries = (clicked: number): BankReferralEntry[] =>
  ['Mercury', 'Relay', 'Payset', 'Wise'].map((label, i) => ({
    slug: label.toLowerCase(),
    label,
    clicked_at: i < clicked ? '2026-11-01T10:00:00Z' : null,
  }))

const render = (e: BankReferralEntry[]) => renderToStaticMarkup(createElement(BankReferralsPanel, { entries: e }))

describe('Partner Bank Applications always starts closed (Antonio 2026-11-14)', () => {
  it('no bank clicked: closed, says "No activity"', () => {
    const h = render(entries(0))
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('No activity')
    expect(h).not.toContain('Not Clicked')
  })

  it('banks clicked: STILL closed, and the red "applied" tag is in the header', () => {
    const h = render(entries(2))
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('2 applied')
    expect(h).toContain('text-red-700')
    // the list of banks is not drawn until it is opened
    expect(h).not.toContain('Clicked')
    expect(h).not.toContain('Mercury')
  })

  it('no banks in the catalog: nothing is drawn', () => {
    expect(render([])).toBe('')
  })
})
