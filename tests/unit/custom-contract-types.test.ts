import { describe, it, expect } from 'vitest'
import { isCustomContractType, isStandaloneAgreementType, isBuiltInAgreementType, customContractTypeForSlug, contractTypeToKeep, typedCustomContractTypeProblem, STANDALONE_AGREEMENT_TYPES } from '@/lib/offers/standalone-contract-types'
import { signKindFor } from '@/lib/offers/public-signing'

describe('custom contract types — the plain string rule for NEW services', () => {
  it('custom_<name> is a custom type; nothing else is', () => {
    for (const t of ['custom_apostille', 'custom_a', 'custom_dba_2', 'custom_x9']) expect(isCustomContractType(t), t).toBe(true)
    for (const t of ['custom_', 'custom', 'Custom_apostille', 'custom_Apostille', 'custom-apostille', 'custom_a b', 'xcustom_a', 'tax_return', '', null, undefined, 5]) expect(isCustomContractType(t as never), String(t)).toBe(false)
  })

  it('a custom type is a short contract (signed on the short-contract page); the built-in eight still are; formation/onboarding are not', () => {
    expect(isStandaloneAgreementType('custom_apostille')).toBe(true)
    for (const t of STANDALONE_AGREEMENT_TYPES) expect(isStandaloneAgreementType(t)).toBe(true)
    for (const t of ['formation', 'onboarding', 'renewal', 'zz_unknown', '']) expect(isStandaloneAgreementType(t), t).toBe(false)
  })

  it('built-in means one of the eight whose wording is in code — never a custom type', () => {
    expect(isBuiltInAgreementType('shipping')).toBe(true)
    expect(isBuiltInAgreementType('custom_apostille')).toBe(false)
  })

  it('signing routes a custom type to the short-contract signer, like the built-in ones', () => {
    expect(signKindFor('custom_apostille')).toBe('standalone')
    expect(signKindFor('formation')).toBe('main')
    expect(signKindFor('onboarding')).toBe('service')
  })

  it('the type for a service comes from its catalog slug', () => {
    expect(customContractTypeForSlug('apostille')).toBe('custom_apostille')
    expect(customContractTypeForSlug('Public Notary 2')).toBe('custom_public_notary_2')
    expect(customContractTypeForSlug('  --Dba!! ')).toBe('custom_dba')
    expect(customContractTypeForSlug('')).toBeNull()
    expect(customContractTypeForSlug('!!!')).toBeNull()
    // whatever it produces always satisfies the rule
    for (const s of ['a', 'apostille', 'X Y Z', 'é-ü', '9lives']) { const t = customContractTypeForSlug(s); if (t) expect(isCustomContractType(t), s).toBe(true) }
  })
})

describe('contractTypeToKeep — a save of the service page never unlinks the service’s own contract', () => {
  it('keeps custom_* whatever the page sent (empty, stale, typed over)', () => {
    for (const sent of ['', null, undefined, 'formation', 'custom_other', 'shipping']) {
      expect(contractTypeToKeep('custom_apostille', sent as never), String(sent)).toBe('custom_apostille')
    }
  })
  it('otherwise takes what the page sent, trimmed, or null when empty', () => {
    expect(contractTypeToKeep(null, ' shipping ')).toBe('shipping')
    expect(contractTypeToKeep('formation', 'itin')).toBe('itin')
    expect(contractTypeToKeep('shipping', '')).toBeNull()
    expect(contractTypeToKeep(undefined, undefined)).toBeNull()
  })
})

describe('typedCustomContractTypeProblem — a hand-typed custom_* type on the service page is refused', () => {
  it('a custom type that is not the service’s own stored one is refused with the way out', () => {
    for (const [stored, typed] of [[null, 'custom_apostille'], ['', 'custom_x'], ['shipping', 'custom_x'], ['custom_a', 'custom_b']] as const) {
      expect(typedCustomContractTypeProblem(stored, typed), `${stored}/${typed}`).toMatch(/created by the Contract card, not typed/)
    }
  })
  it('the service’s own stored custom type, empty, and ordinary types are fine', () => {
    expect(typedCustomContractTypeProblem('custom_a', 'custom_a')).toBeNull()
    expect(typedCustomContractTypeProblem('custom_a', ' custom_a ')).toBeNull()
    expect(typedCustomContractTypeProblem(null, '')).toBeNull()
    expect(typedCustomContractTypeProblem(null, null)).toBeNull()
    expect(typedCustomContractTypeProblem('shipping', 'itin')).toBeNull()
    expect(typedCustomContractTypeProblem(null, 'Custom_X')).toBeNull() // not the custom_ pattern: another rule's business
  })
})
