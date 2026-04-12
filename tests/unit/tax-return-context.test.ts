import { describe, it, expect } from 'vitest'
import { findTaxReturnService } from '@/lib/tax-return-context'

describe('findTaxReturnService', () => {
  // ─── not_found cases ───

  it('returns not_found for null services', () => {
    expect(findTaxReturnService(null)).toEqual({ status: 'not_found' })
  })

  it('returns not_found for undefined services', () => {
    expect(findTaxReturnService(undefined)).toEqual({ status: 'not_found' })
  })

  it('returns not_found for empty array', () => {
    expect(findTaxReturnService([])).toEqual({ status: 'not_found' })
  })

  it('returns not_found when no entry matches', () => {
    const services = [
      { name: 'LLC Formation', pipeline_type: 'Company Formation', service_context: 'business' },
      { name: 'EIN Application', pipeline_type: 'EIN' },
    ]
    expect(findTaxReturnService(services)).toEqual({ status: 'not_found' })
  })

  // ─── found: single match by pipeline_type ───

  it('finds by pipeline_type', () => {
    const services = [
      { name: 'Tax Return', pipeline_type: 'Tax Return', contract_type: 'tax_return', service_context: 'business' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('business')
    }
  })

  // ─── found: single match by contract_type ───

  it('finds by contract_type when no pipeline_type', () => {
    const services = [
      { name: 'Filing Service', contract_type: 'tax_return', service_context: 'individual' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('individual')
    }
  })

  // ─── found: single match by name ───

  it('finds by name containing "tax return" (case-insensitive)', () => {
    const services = [
      { name: 'Tax Return 2025', price: '$1000', service_context: 'business' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('business')
    }
  })

  it('finds by name with mixed case', () => {
    const services = [
      { name: 'Solo TAX RETURN 2025', service_context: 'individual' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('individual')
    }
  })

  // ─── found: one entry matching multiple criteria (dedup) ───

  it('deduplicates when one entry matches on multiple criteria', () => {
    const services = [
      { name: 'Tax Return', pipeline_type: 'Tax Return', contract_type: 'tax_return', service_context: 'business' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('business')
    }
  })

  it('one entry with all three criteria among other non-matching entries', () => {
    const services = [
      { name: 'LLC Formation', pipeline_type: 'Company Formation' },
      { name: 'Tax Return', pipeline_type: 'Tax Return', contract_type: 'tax_return', service_context: 'business' },
      { name: 'EIN', pipeline_type: 'EIN' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('business')
    }
  })

  // ─── multiple_matches ───

  it('returns multiple_matches when two different entries match', () => {
    const services = [
      { name: 'Tax Return 2025', service_context: 'business' },
      { name: 'Tax Return 2024', service_context: 'business' },
    ]
    const result = findTaxReturnService(services)
    expect(result).toEqual({ status: 'multiple_matches', count: 2 })
  })

  it('returns multiple_matches when entries match on different criteria', () => {
    const services = [
      { name: 'Filing Service', pipeline_type: 'Tax Return', service_context: 'business' },
      { name: 'Tax Return Addon', service_context: 'individual' },
    ]
    const result = findTaxReturnService(services)
    expect(result).toEqual({ status: 'multiple_matches', count: 2 })
  })

  // ─── null / missing service_context ───

  it('returns null service_context when field is absent', () => {
    const services = [
      { name: 'Tax Return', pipeline_type: 'Tax Return' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBeNull()
    }
  })

  it('returns null service_context when field is non-string', () => {
    const services = [
      { name: 'Tax Return', pipeline_type: 'Tax Return', service_context: 123 },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBeNull()
    }
  })

  // ─── "ask" context ───

  it('returns "ask" as service_context (caller decides to block)', () => {
    const services = [
      { name: 'Tax Return', pipeline_type: 'Tax Return', service_context: 'ask' },
    ]
    const result = findTaxReturnService(services)
    expect(result.status).toBe('found')
    if (result.status === 'found') {
      expect(result.service_context).toBe('ask')
    }
  })
})
