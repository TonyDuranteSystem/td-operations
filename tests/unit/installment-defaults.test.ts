import { describe, it, expect } from 'vitest'
import { defaultInstallmentAmount } from '@/lib/billing/installment-defaults'

describe('defaultInstallmentAmount', () => {
  it('returns 1250 for Multi Member LLC', () => {
    expect(defaultInstallmentAmount('Multi Member LLC')).toBe(1250)
  })

  it('returns 1250 for "MMLLC" shorthand', () => {
    expect(defaultInstallmentAmount('MMLLC')).toBe(1250)
  })

  it('matches MMLLC case-insensitively', () => {
    expect(defaultInstallmentAmount('multi member llc')).toBe(1250)
    expect(defaultInstallmentAmount('mmllc')).toBe(1250)
  })

  it('returns 1000 for Single Member LLC', () => {
    expect(defaultInstallmentAmount('Single Member LLC')).toBe(1000)
  })

  it('returns 1000 for any non-MMLLC entity type', () => {
    expect(defaultInstallmentAmount('C-Corp')).toBe(1000)
    expect(defaultInstallmentAmount('S-Corp')).toBe(1000)
    expect(defaultInstallmentAmount('Sole Proprietorship')).toBe(1000)
  })

  it('returns 1000 for null / undefined / empty', () => {
    expect(defaultInstallmentAmount(null)).toBe(1000)
    expect(defaultInstallmentAmount(undefined)).toBe(1000)
    expect(defaultInstallmentAmount('')).toBe(1000)
  })
})
