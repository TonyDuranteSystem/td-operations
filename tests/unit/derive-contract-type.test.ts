import { describe, it, expect } from 'vitest'
import { deriveContractType } from '@/lib/offers/derive-contract-type'

describe('deriveContractType', () => {
  it('picks formation when it is the only type', () => {
    expect(deriveContractType(['formation'])).toBe('formation')
  })

  it('picks formation even when a non-formation service was checked first (the bug report)', () => {
    // Company Formation + ITIN Application, checked ITIN → Formation.
    expect(deriveContractType(['itin', 'formation'])).toBe('formation')
  })

  it('picks formation regardless of position anywhere in the selection', () => {
    expect(deriveContractType(['itin', 'tax_return', 'formation'])).toBe('formation')
    expect(deriveContractType(['formation', 'itin', 'tax_return'])).toBe('formation')
  })

  it('picks onboarding over any other non-formation type, in any order', () => {
    expect(deriveContractType(['itin', 'onboarding'])).toBe('onboarding')
    expect(deriveContractType(['onboarding', 'itin'])).toBe('onboarding')
  })

  it('formation still wins over onboarding when both are somehow selected', () => {
    expect(deriveContractType(['onboarding', 'formation'])).toBe('formation')
  })

  it('Tax Return wins over ITIN whatever the click order (S1 2026-09-27)', () => {
    expect(deriveContractType(['itin', 'tax_return'])).toBe('tax_return')
    expect(deriveContractType(['tax_return', 'itin'])).toBe('tax_return')
  })

  it('falls back to the first real type otherwise', () => {
    expect(deriveContractType(['itin', 'renewal'])).toBe('itin')
  })

  it('skips null/undefined entries (services with no catalog contract_type)', () => {
    expect(deriveContractType([null, undefined, 'itin'])).toBe('itin')
  })

  it('defaults to formation when nothing is selected or nothing has a type', () => {
    expect(deriveContractType([])).toBe('formation')
    expect(deriveContractType([null, undefined])).toBe('formation')
  })
})
