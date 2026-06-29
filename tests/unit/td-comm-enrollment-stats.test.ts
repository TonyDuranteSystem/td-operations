import { describe, it, expect } from 'vitest'
import { computeEnrollmentStats, filterByStatus } from '@/lib/td-communication/enrollment-stats'
import type { CommEnrollment, EnrollmentStatus } from '@/lib/td-communication/types'

const enrollment = (over: Partial<CommEnrollment>): CommEnrollment => ({
  id: over.id ?? 'id',
  account_id: null,
  contact_id: null,
  lead_id: null,
  partner_id: null,
  service_delivery_id: null,
  client_type: null,
  package_slug: over.package_slug ?? 'logo',
  status: over.status ?? 'enrolled',
  form_data: {},
  conversation_id: null,
  metadata: over.metadata ?? {},
  created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  subject: { type: 'account', id: 'a', name: 'Acme', email: null },
  deadline: null,
  notes: null,
})

describe('computeEnrollmentStats', () => {
  it('counts total and by-status', () => {
    const stats = computeEnrollmentStats([
      enrollment({ status: 'enrolled' }),
      enrollment({ status: 'delivered' }),
      enrollment({ status: 'delivered' }),
    ])
    expect(stats.total).toBe(3)
    expect(stats.byStatus).toEqual({ enrolled: 1, delivered: 2 })
  })

  it('returns null avg when no enrollment has delivered_at', () => {
    const stats = computeEnrollmentStats([enrollment({ status: 'delivered' })])
    expect(stats.avgDeliveryDays).toBeNull()
  })

  it('averages delivery days over rows with a valid delivered_at', () => {
    const stats = computeEnrollmentStats([
      enrollment({
        created_at: '2026-06-01T00:00:00.000Z',
        metadata: { delivered_at: '2026-06-05T00:00:00.000Z' }, // 4 days
      }),
      enrollment({
        created_at: '2026-06-01T00:00:00.000Z',
        metadata: { delivered_at: '2026-06-03T00:00:00.000Z' }, // 2 days
      }),
      enrollment({ status: 'enrolled' }), // no delivered_at → excluded
    ])
    expect(stats.avgDeliveryDays).toBe(3) // (4 + 2) / 2
  })

  it('ignores delivered_at that predates created_at (clock skew) and never divides by zero', () => {
    const stats = computeEnrollmentStats([
      enrollment({
        created_at: '2026-06-05T00:00:00.000Z',
        metadata: { delivered_at: '2026-06-01T00:00:00.000Z' },
      }),
    ])
    expect(stats.avgDeliveryDays).toBeNull()
  })

  it('ignores malformed delivered_at', () => {
    const stats = computeEnrollmentStats([
      enrollment({ metadata: { delivered_at: 'not-a-date' } }),
      enrollment({ metadata: { delivered_at: 123 as unknown as string } }),
    ])
    expect(stats.avgDeliveryDays).toBeNull()
  })

  it('handles an empty list', () => {
    const stats = computeEnrollmentStats([])
    expect(stats).toEqual({ total: 0, byStatus: {}, avgDeliveryDays: null })
  })
})

describe('filterByStatus', () => {
  const list = [enrollment({ status: 'enrolled' }), enrollment({ status: 'delivered' })]

  it('returns all when status is absent or invalid', () => {
    expect(filterByStatus(list)).toHaveLength(2)
    expect(filterByStatus(list, '')).toHaveLength(2)
    expect(filterByStatus(list, 'nonsense')).toHaveLength(2)
  })

  it('filters to a valid status', () => {
    const r = filterByStatus(list, 'delivered' as EnrollmentStatus)
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('delivered')
  })
})
