import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/components/ui/floating-document-window', () => ({ FloatingDocumentWindow: () => null }))

import { SignedContractsCard, contractsHeaderSummary } from '@/components/accounts/signed-contracts-card'
import type { AccountContractLine } from '@/lib/signed-contracts/account-lines'

const closed = (lines: AccountContractLine[] | null) => renderToStaticMarkup(createElement(SignedContractsCard, { lines }))
const opened = (lines: AccountContractLine[] | null) => renderToStaticMarkup(createElement(SignedContractsCard, { lines, startOpen: true }))
const line = (over: Partial<AccountContractLine> = {}): AccountContractLine => ({
  id: 'c1',
  name: 'Onboarding contract',
  signedOn: '2026-02-12',
  isMain: true,
  fileAvailable: true,
  ...over,
})

describe('SignedContractsCard — closed when the page loads', () => {
  it('starts closed: the header and a one-line summary show, no list and no Open button', () => {
    const h = closed([line()])
    expect(h).toContain('Signed contracts (1)')
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('Onboarding contract · signed Feb 12, 2026')
    expect(h).not.toContain('signed-contracts-body')
    expect(h).not.toContain('>Open<')
  })

  it('no floating window is open when the page loads', () => {
    expect(closed([line()])).not.toContain('floating-document-window')
  })

  it('a company with no contract says so in the header, with no count', () => {
    const h = closed([])
    expect(h).toContain('No signed contract in the system')
    expect(h).toContain('Signed contracts')
    expect(h).not.toContain('Signed contracts (')
  })

  it('a lookup that failed never says "No signed contract": the header says it could not be read', () => {
    const h = closed(null)
    expect(h).toContain('Could not be read just now')
    expect(h).not.toContain('No signed contract in the system')
  })
})

describe('contractsHeaderSummary', () => {
  it('one contract: its name and the day it was signed', () => {
    expect(contractsHeaderSummary([line()])).toBe('Onboarding contract · signed Feb 12, 2026')
  })
  it('one contract with no signing date: just the name', () => {
    expect(contractsHeaderSummary([line({ signedOn: null })])).toBe('Onboarding contract')
  })
  it('several contracts: the names, in order', () => {
    expect(contractsHeaderSummary([line(), line({ id: 'c2', name: 'ITIN Application Service Agreement' }), line({ id: 'c3', name: 'Annual renewal agreement 2026' })])).toBe(
      'Onboarding contract · ITIN Application Service Agreement · Annual renewal agreement 2026',
    )
  })
})

describe('SignedContractsCard — once opened', () => {
  it('a signed contract: its name, the signing day, and an Open button that works', () => {
    const h = opened([line()])
    expect(h).toContain('aria-expanded="true"')
    expect(h).toContain('Onboarding contract')
    expect(h).toContain('signed Feb 12, 2026')
    expect(h).toContain('>Open<')
    expect(h).not.toMatch(/<button[^>]* disabled=""/)
    expect(h).not.toContain('No signed contract in the system')
  })

  it('opened but empty: says so plainly, with no button', () => {
    const h = opened([])
    expect(h).toContain('No signed contract in the system')
    expect(h).not.toContain('>Open<')
  })

  it('opened after a failed lookup: says the contracts could not be read, never "No signed contract"', () => {
    const h = opened(null)
    expect(h).toContain('The signed contracts could not be read just now')
    expect(h).not.toContain('No signed contract in the system')
    expect(h).not.toContain('>Open<')
  })

  it('a renewal agreement is shown, named as one', () => {
    expect(opened([line({ id: 'r', name: 'Annual renewal agreement 2026', isMain: false, signedOn: '2026-04-03' })])).toContain('Annual renewal agreement 2026')
  })

  it('a contract whose file is not recorded: the line shows, Open is greyed out and says why', () => {
    const h = opened([line({ fileAvailable: false })])
    expect(h).toMatch(/<button[^>]* disabled=""/)
    expect(h).toContain('The signed file is not available right now.')
  })

  it('a contract with no signing date shows without a date', () => {
    const h = opened([line({ signedOn: null })])
    expect(h).toContain('Onboarding contract')
    expect(h).not.toContain('signed ')
  })

  it('several contracts: one line each, each with its own Open button', () => {
    const h = opened([line(), line({ id: 'c2', name: 'Annual renewal agreement 2026', isMain: false })])
    expect(h.match(/data-testid="signed-contract-line"/g)?.length).toBe(2)
    expect(h.match(/>Open</g)?.length).toBe(2)
  })
})
