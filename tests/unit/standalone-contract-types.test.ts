import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STANDALONE_AGREEMENT_TYPES, isStandaloneAgreementType } from '@/lib/offers/standalone-contract-types'
import { signKindFor } from '@/lib/offers/public-signing'
import { getServiceLabel } from '@/lib/portal/offer-invoice-policy'

const root = process.cwd()
const agreementSrc = readFileSync(join(root, 'app/offer/[token]/contract/standalone-service-agreement.tsx'), 'utf8')
const dialogSrc = readFileSync(join(root, 'app/(dashboard)/leads/[id]/components/confirm-payment-dialog.tsx'), 'utf8')

describe('standalone agreement types — one list, everywhere', () => {
  it('every type is signed by the standalone component', () => {
    for (const t of STANDALONE_AGREEMENT_TYPES) expect(signKindFor(t)).toBe('standalone')
  })

  it('formation, onboarding and renewal keep their own components', () => {
    expect(signKindFor('formation')).toBe('main')
    expect(signKindFor(null)).toBe('main')
    expect(signKindFor('onboarding')).toBe('service')
    expect(signKindFor('renewal')).toBe('renewal')
  })

  it('every type has its wording block in SERVICE_CONTENT (else the contract page renders nothing)', () => {
    for (const t of STANDALONE_AGREEMENT_TYPES) {
      expect(agreementSrc, t).toMatch(new RegExp(`^  ${t}: \\{`, 'm'))
    }
  })

  it('every type has an invoice label (not the generic "Service")', () => {
    for (const t of STANDALONE_AGREEMENT_TYPES) expect(getServiceLabel(t), t).not.toBe('Service')
  })

  it('every service-type except the old tax/ITIN/closure ones is selectable in Confirm Payment', () => {
    for (const t of ['company_change_name', 'ein_change_name', 'shipping', 'public_notary', 'consulting_call']) {
      expect(dialogSrc, t).toContain(`value: '${t}'`)
    }
  })

  it('isStandaloneAgreementType rejects everything else', () => {
    expect(isStandaloneAgreementType('formation')).toBe(false)
    expect(isStandaloneAgreementType(undefined)).toBe(false)
    expect(isStandaloneAgreementType('shipping')).toBe(true)
  })

  it('no agreement text still talks about tax returns unless it is the tax return one', () => {
    for (const t of STANDALONE_AGREEMENT_TYPES.filter((x) => !['tax_return', 'itin', 'closure'].includes(x))) {
      const start = agreementSrc.indexOf(`  ${t}: {`)
      const block = agreementSrc.slice(start, agreementSrc.indexOf('workPhrase', start))
      expect(block.toLowerCase(), t).not.toContain('tax return')
    }
  })
})
