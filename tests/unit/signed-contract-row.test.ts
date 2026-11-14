import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/components/ui/floating-document-window', () => ({ FloatingDocumentWindow: () => null }))

import { SignedContractRow } from '@/components/accounts/signed-contract-row'
import type { AccountContractLine } from '@/lib/signed-contracts/account-lines'

const html = (lines: AccountContractLine[] | null) => renderToStaticMarkup(createElement(SignedContractRow, { lines }))
const line = (over: Partial<AccountContractLine> = {}): AccountContractLine => ({
  id: 'c1',
  name: 'Onboarding contract',
  signedOn: '2026-02-12',
  isMain: true,
  fileAvailable: true,
  ...over,
})

describe('SignedContractRow — what is on screen when the page loads', () => {
  it('a company with a signed contract: its name, the signing day, and an Open button that works', () => {
    const h = html([line()])
    expect(h).toContain('Signed contract')
    expect(h).toContain('Onboarding contract')
    expect(h).toContain('signed Feb 12, 2026')
    expect(h).toContain('>Open<')
    expect(h).not.toMatch(/<button[^>]* disabled=""/)
    expect(h).not.toContain('No signed contract in the system')
  })

  it('a company with no contract on record says so plainly, with no button', () => {
    const h = html([])
    expect(h).toContain('No signed contract in the system')
    expect(h).not.toContain('>Open<')
  })

  it('a lookup that failed never says "No signed contract": it says the contracts could not be read', () => {
    const h = html(null)
    expect(h).toContain('The signed contracts could not be read just now')
    expect(h).not.toContain('No signed contract in the system')
    expect(h).not.toContain('>Open<')
  })

  it('a renewal agreement is shown, named as one', () => {
    expect(html([line({ id: 'r', name: 'Annual renewal agreement 2026', isMain: false, signedOn: '2026-04-03' })])).toContain('Annual renewal agreement 2026')
  })

  it('a contract whose file is not recorded: the line shows, Open is greyed out and says why', () => {
    const h = html([line({ fileAvailable: false })])
    expect(h).toMatch(/<button[^>]* disabled=""/)
    expect(h).toContain('The signed file is not available right now.')
  })

  it('a contract with no signing date shows without a date', () => {
    const h = html([line({ signedOn: null })])
    expect(h).toContain('Onboarding contract')
    expect(h).not.toContain('signed ')
  })

  it('several contracts: one line each', () => {
    const h = html([line(), line({ id: 'c2', name: 'Annual renewal agreement 2026', isMain: false })])
    expect(h.match(/data-testid="signed-contract-line"/g)?.length).toBe(2)
  })

  it('no floating window is open when the page loads', () => {
    expect(html([line()])).not.toContain('floating-document-window')
  })
})
