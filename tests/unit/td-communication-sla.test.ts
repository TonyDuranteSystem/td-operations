import { describe, it, expect } from 'vitest'
import {
  computeDeadlineAt,
  isSlaTracked,
  slaSummary,
} from '@/lib/td-communication/pipeline'
import { overdueAlertMessage } from '@/lib/td-communication/sla'
import type { CommEnrollment } from '@/lib/td-communication/types'

const enrollment = (over: Partial<CommEnrollment>): CommEnrollment => ({
  id: over.id ?? 'id',
  account_id: null,
  contact_id: null,
  lead_id: null,
  partner_id: null,
  service_delivery_id: null,
  client_type: null,
  package_slug: over.package_slug ?? 'logo',
  status: over.status ?? 'in_progress',
  form_data: {},
  conversation_id: over.conversation_id ?? null,
  metadata: over.metadata ?? {},
  deadline_at: over.deadline_at ?? null,
  created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  subject: { type: 'account', id: 'a', name: 'Acme', email: null },
  deadline: over.deadline ?? null,
  notes: null,
})

describe('computeDeadlineAt', () => {
  it('adds whole days to the base, as ISO', () => {
    expect(computeDeadlineAt('2026-06-01T00:00:00.000Z', 5)).toBe('2026-06-06T00:00:00.000Z')
    expect(computeDeadlineAt('2026-06-01T12:30:00.000Z', 2)).toBe('2026-06-03T12:30:00.000Z')
    expect(computeDeadlineAt('2026-06-01T00:00:00.000Z', 0)).toBe('2026-06-01T00:00:00.000Z')
  })

  it('returns null for a bad base or a non-finite/negative day count', () => {
    expect(computeDeadlineAt(null, 5)).toBeNull()
    expect(computeDeadlineAt(undefined, 5)).toBeNull()
    expect(computeDeadlineAt('not-a-date', 5)).toBeNull()
    expect(computeDeadlineAt('2026-06-01T00:00:00.000Z', null)).toBeNull()
    expect(computeDeadlineAt('2026-06-01T00:00:00.000Z', NaN)).toBeNull()
    expect(computeDeadlineAt('2026-06-01T00:00:00.000Z', -1)).toBeNull()
  })
})

describe('isSlaTracked', () => {
  it('is false for terminal statuses, true otherwise', () => {
    expect(isSlaTracked('delivered')).toBe(false)
    expect(isSlaTracked('cancelled')).toBe(false)
    expect(isSlaTracked('enrolled')).toBe(true)
    expect(isSlaTracked('form_submitted')).toBe(true)
    expect(isSlaTracked('in_progress')).toBe(true)
    expect(isSlaTracked('concept_ready')).toBe(true)
    expect(isSlaTracked('approved')).toBe(true)
    expect(isSlaTracked('revision')).toBe(true)
  })
})

describe('slaSummary', () => {
  const now = new Date('2026-06-28T12:00:00Z')

  it('counts on-time vs overdue over tracked rows with a deadline', () => {
    const s = slaSummary(
      [
        enrollment({ status: 'in_progress', deadline: '2026-06-26' }), // overdue
        enrollment({ status: 'in_progress', deadline: '2026-07-10' }), // green → on time
        enrollment({ status: 'revision', deadline: '2026-06-29' }), // tomorrow (yellow) → on time
        enrollment({ status: 'delivered', deadline: '2026-06-01' }), // terminal → skipped
        enrollment({ status: 'cancelled', deadline: '2026-06-01' }), // terminal → skipped
        enrollment({ status: 'in_progress', deadline: null }), // no deadline → skipped
      ],
      now,
    )
    expect(s).toEqual({ onTime: 2, overdue: 1 })
  })

  it('is all-zero when nothing is trackable', () => {
    expect(slaSummary([], now)).toEqual({ onTime: 0, overdue: 0 })
    expect(slaSummary([enrollment({ status: 'delivered', deadline: '2026-06-01' })], now)).toEqual({
      onTime: 0,
      overdue: 0,
    })
  })
})

describe('overdueAlertMessage', () => {
  it('pluralizes and floors at one day', () => {
    expect(overdueAlertMessage('Acme LLC', 3)).toBe('⚠️ Project Acme LLC is overdue by 3 days')
    expect(overdueAlertMessage('Acme LLC', 1)).toBe('⚠️ Project Acme LLC is overdue by 1 day')
    expect(overdueAlertMessage('Acme LLC', 0)).toBe('⚠️ Project Acme LLC is overdue by 1 day')
  })
})
