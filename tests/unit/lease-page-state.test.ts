import { describe, it, expect } from 'vitest'
import { leasePageView } from '@/lib/lease/page-state'

const base = { loading: false, error: '', hasLease: false, verified: false, isAdminPreview: false, isPortal: false }

describe('leasePageView — the emailed lease link must never be a blank page', () => {
  it('first-time visitor: the server sent no lease, only "ask for the email" -> show the email box (the 2026-10-01 blank-page bug)', () => {
    expect(leasePageView({ ...base })).toBe('email_gate')
  })
  it('still loading -> loading screen', () => {
    expect(leasePageView({ ...base, loading: true })).toBe('loading')
  })
  it('an error message wins over everything else once loading is over', () => {
    expect(leasePageView({ ...base, error: 'This lease link is invalid or has expired.' })).toBe('error')
  })
  it('verified with the lease -> the lease', () => {
    expect(leasePageView({ ...base, verified: true, hasLease: true })).toBe('lease')
  })
  it('staff preview and the portal skip the email box', () => {
    expect(leasePageView({ ...base, isAdminPreview: true, hasLease: true })).toBe('lease')
    expect(leasePageView({ ...base, isPortal: true, hasLease: true })).toBe('lease')
  })
  it('verified/preview but no lease yet -> empty (no crash, no email box)', () => {
    expect(leasePageView({ ...base, verified: true })).toBe('empty')
    expect(leasePageView({ ...base, isAdminPreview: true })).toBe('empty')
  })
})
