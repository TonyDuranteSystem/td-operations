import { describe, it, expect } from 'vitest'
import { computeEnrollmentStats, filterByStatus } from '@/lib/td-communication/enrollment-stats'
import type { CommEnrollment, EnrollmentStatus } from '@/lib/td-communication/types'

const NOW = new Date('2026-06-10T00:00:00.000Z')

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
  deadline_at: over.deadline_at ?? null,
  created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  subject: { type: 'account', id: 'a', name: 'Acme', email: null },
  deadline: over.deadline ?? null,
  notes: null,
})

describe('computeEnrollmentStats', () => {
  it('counts total and by-status', () => {
    const stats = computeEnrollmentStats([
      enrollment({ status: 'enrolled' }),
      enrollment({ status: 'delivered' }),
      enrollment({ status: 'delivered' }),
    ], NOW)
    expect(stats.total).toBe(3)
    expect(stats.byStatus).toEqual({ enrolled: 1, delivered: 2 })
  })

  it('returns null avg when no enrollment has delivered_at', () => {
    const stats = computeEnrollmentStats([enrollment({ status: 'delivered' })], NOW)
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
    ], NOW)
    expect(stats.avgDeliveryDays).toBe(3) // (4 + 2) / 2
  })

  it('ignores delivered_at that predates created_at (clock skew) and never divides by zero', () => {
    const stats = computeEnrollmentStats([
      enrollment({
        created_at: '2026-06-05T00:00:00.000Z',
        metadata: { delivered_at: '2026-06-01T00:00:00.000Z' },
      }),
    ], NOW)
    expect(stats.avgDeliveryDays).toBeNull()
  })

  it('ignores malformed delivered_at', () => {
    const stats = computeEnrollmentStats([
      enrollment({ metadata: { delivered_at: 'not-a-date' } }),
      enrollment({ metadata: { delivered_at: 123 as unknown as string } }),
    ], NOW)
    expect(stats.avgDeliveryDays).toBeNull()
  })

  it('handles an empty list', () => {
    const stats = computeEnrollmentStats([], NOW)
    expect(stats).toEqual({ total: 0, byStatus: {}, avgDeliveryDays: null, slaCompliancePct: null, overdueCount: 0 })
  })
})

describe('computeEnrollmentStats — SLA (Phase 10)', () => {
  it('slaCompliancePct = delivered-on-time / delivered-with-a-deadline-and-delivered_at', () => {
    const stats = computeEnrollmentStats(
      [
        // on time: delivered 2026-06-05, deadline 2026-06-06
        enrollment({ status: 'delivered', deadline: '2026-06-06', metadata: { delivered_at: '2026-06-05T10:00:00.000Z' } }),
        // late: delivered 2026-06-08, deadline 2026-06-06
        enrollment({ status: 'delivered', deadline: '2026-06-06', metadata: { delivered_at: '2026-06-08T10:00:00.000Z' } }),
        // delivered but no deadline → excluded from compliance
        enrollment({ status: 'delivered', metadata: { delivered_at: '2026-06-05T00:00:00.000Z' } }),
        // not delivered → excluded
        enrollment({ status: 'in_progress', deadline: '2026-06-06' }),
      ],
      NOW,
    )
    expect(stats.slaCompliancePct).toBe(50) // 1 of 2 judged on time
  })

  it('counts a same-calendar-day delivery as on time even if hours past the deadline timestamp', () => {
    const stats = computeEnrollmentStats(
      [
        enrollment({ status: 'delivered', deadline: '2026-06-06', metadata: { delivered_at: '2026-06-06T23:30:00.000Z' } }),
      ],
      NOW,
    )
    expect(stats.slaCompliancePct).toBe(100)
  })

  it('slaCompliancePct is null when no delivered row has a deadline + delivered_at', () => {
    const stats = computeEnrollmentStats([enrollment({ status: 'delivered' })], NOW)
    expect(stats.slaCompliancePct).toBeNull()
  })

  it('overdueCount counts tracked, past-deadline projects (excludes delivered/cancelled)', () => {
    const stats = computeEnrollmentStats(
      [
        enrollment({ status: 'in_progress', deadline: '2026-06-05' }), // overdue vs NOW (06-10)
        enrollment({ status: 'revision', deadline: '2026-06-01' }), // overdue
        enrollment({ status: 'in_progress', deadline: '2026-06-20' }), // future → not overdue
        enrollment({ status: 'delivered', deadline: '2026-06-01' }), // terminal → excluded
        enrollment({ status: 'cancelled', deadline: '2026-06-01' }), // terminal → excluded
        enrollment({ status: 'in_progress', deadline: null }), // no deadline → excluded
      ],
      NOW,
    )
    expect(stats.overdueCount).toBe(2)
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
