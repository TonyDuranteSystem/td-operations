import { describe, it, expect } from 'vitest'
import {
  isTerminalEnrollmentStatus,
  normalizeClientType,
  businessNameFromFormData,
  brandAuditSubmittedMessage,
  pickActiveClientEnrollment,
} from '@/lib/td-communication/brand-audit'
import type { CommEnrollmentRow } from '@/lib/td-communication/types'

function row(partial: Partial<CommEnrollmentRow>): CommEnrollmentRow {
  return {
    id: 'id',
    account_id: null,
    contact_id: null,
    lead_id: null,
    partner_id: null,
    service_delivery_id: null,
    client_type: 'new_brand',
    package_slug: null,
    status: 'enrolled',
    form_data: {},
    conversation_id: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

describe('isTerminalEnrollmentStatus', () => {
  it('treats delivered + cancelled as terminal', () => {
    expect(isTerminalEnrollmentStatus('delivered')).toBe(true)
    expect(isTerminalEnrollmentStatus('cancelled')).toBe(true)
  })
  it('treats every other status as non-terminal', () => {
    for (const s of ['enrolled', 'form_submitted', 'in_progress', 'concept_ready', 'approved', 'revision']) {
      expect(isTerminalEnrollmentStatus(s)).toBe(false)
    }
  })
})

describe('normalizeClientType', () => {
  it('returns rebrand only for the exact value', () => {
    expect(normalizeClientType('rebrand')).toBe('rebrand')
  })
  it('defaults everything else to new_brand', () => {
    expect(normalizeClientType('new_brand')).toBe('new_brand')
    expect(normalizeClientType('')).toBe('new_brand')
    expect(normalizeClientType(undefined)).toBe('new_brand')
    expect(normalizeClientType(null)).toBe('new_brand')
    expect(normalizeClientType('SMLLC')).toBe('new_brand')
  })
})

describe('businessNameFromFormData', () => {
  it('reads business_name when present', () => {
    expect(businessNameFromFormData({ business_name: 'Acme LLC' })).toBe('Acme LLC')
  })
  it('falls back to brand_name (the DB-driven question set)', () => {
    expect(businessNameFromFormData({ brand_name: 'Nova LLC' })).toBe('Nova LLC')
  })
  it('prefers business_name over brand_name when both present', () => {
    expect(businessNameFromFormData({ business_name: 'Acme LLC', brand_name: 'Nova LLC' })).toBe('Acme LLC')
  })
  it('trims whitespace', () => {
    expect(businessNameFromFormData({ business_name: '  Acme  ' })).toBe('Acme')
    expect(businessNameFromFormData({ brand_name: '  Nova  ' })).toBe('Nova')
  })
  it('falls back when missing / blank / non-string', () => {
    expect(businessNameFromFormData({})).toBe('New brand')
    expect(businessNameFromFormData({ business_name: '   ' })).toBe('New brand')
    expect(businessNameFromFormData({ business_name: 123 as unknown as string })).toBe('New brand')
  })
})

describe('brandAuditSubmittedMessage', () => {
  it('formats the system notice', () => {
    expect(brandAuditSubmittedMessage('Acme LLC')).toBe('New brand audit submitted: Acme LLC')
  })
})

describe('pickActiveClientEnrollment', () => {
  it('returns null when there are no rows', () => {
    expect(pickActiveClientEnrollment([])).toBeNull()
  })
  it('returns null when every row is terminal', () => {
    expect(pickActiveClientEnrollment([
      row({ id: 'a', status: 'delivered' }),
      row({ id: 'b', status: 'cancelled' }),
    ])).toBeNull()
  })
  it('picks the newest non-terminal row', () => {
    const picked = pickActiveClientEnrollment([
      row({ id: 'old', status: 'enrolled', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'new', status: 'in_progress', created_at: '2026-03-01T00:00:00.000Z' }),
      row({ id: 'mid', status: 'form_submitted', created_at: '2026-02-01T00:00:00.000Z' }),
    ])
    expect(picked?.id).toBe('new')
  })
  it('ignores terminal rows even when they are newest', () => {
    const picked = pickActiveClientEnrollment([
      row({ id: 'active', status: 'enrolled', created_at: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'doneNewest', status: 'delivered', created_at: '2026-09-01T00:00:00.000Z' }),
    ])
    expect(picked?.id).toBe('active')
  })
})
