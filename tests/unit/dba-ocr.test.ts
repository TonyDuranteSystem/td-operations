/**
 * Unit tests for lib/dba-ocr.ts::extractDbaFieldsFromOcr.
 *
 * The extractor is intentionally conservative — only labeled patterns are
 * matched. These tests cover common labels we expect to encounter across
 * state DBA / trade-name certificates, plus the empty/no-match paths.
 */

import { describe, it, expect } from 'vitest'
import { extractDbaFieldsFromOcr } from '@/lib/dba-ocr'

describe('extractDbaFieldsFromOcr', () => {
  it('returns nulls for empty or non-string input', () => {
    expect(extractDbaFieldsFromOcr('')).toEqual({ filed_date: null, registration_number: null })
    expect(extractDbaFieldsFromOcr(undefined as unknown as string)).toEqual({ filed_date: null, registration_number: null })
  })

  it('extracts a labeled ISO filed date', () => {
    const text = 'Filing Date: 2026-01-15\nState of New York'
    expect(extractDbaFieldsFromOcr(text).filed_date).toBe('2026-01-15')
  })

  it('extracts a labeled slash filed date', () => {
    const text = 'Date Filed: 03/14/2025'
    expect(extractDbaFieldsFromOcr(text).filed_date).toBe('2025-03-14')
  })

  it('extracts a labeled long-form filed date', () => {
    const text = 'Filed on January 5, 2024 in the County Clerk\'s office'
    expect(extractDbaFieldsFromOcr(text).filed_date).toBe('2024-01-05')
  })

  it('extracts a registration number with a colon', () => {
    const text = 'Registration No: ABC-12345\nName: Acme Trading'
    expect(extractDbaFieldsFromOcr(text).registration_number).toBe('ABC-12345')
  })

  it('extracts a certificate number label', () => {
    const text = 'CERTIFICATE NUMBER 987654321'
    expect(extractDbaFieldsFromOcr(text).registration_number).toBe('987654321')
  })

  it('returns null for invalid dates', () => {
    const text = 'Date Filed: 13/45/2025'
    expect(extractDbaFieldsFromOcr(text).filed_date).toBeNull()
  })

  it('returns null when no labeled patterns are present', () => {
    const text = 'Generic acknowledgement letter with no DBA-specific labels.'
    expect(extractDbaFieldsFromOcr(text)).toEqual({ filed_date: null, registration_number: null })
  })

  it('does not pick up unrelated numbers as a registration number', () => {
    const text = 'Phone: 555-1234. State: NY.'
    expect(extractDbaFieldsFromOcr(text).registration_number).toBeNull()
  })
})
