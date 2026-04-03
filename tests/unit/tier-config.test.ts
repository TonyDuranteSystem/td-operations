import { describe, it, expect } from 'vitest'
import { isTierFeatureVisible, getDashboardVariant, isPartnerPortal } from '@/lib/portal/tier-config'

describe('isTierFeatureVisible', () => {
  // Lead tier — most restricted
  it('lead: shows dashboard', () => {
    expect(isTierFeatureVisible('lead', 'dashboard')).toBe(true)
  })

  it('lead: shows chat', () => {
    expect(isTierFeatureVisible('lead', 'chat')).toBe(true)
  })

  it('lead: shows documents', () => {
    expect(isTierFeatureVisible('lead', 'documents')).toBe(true)
  })

  it('lead: hides services', () => {
    expect(isTierFeatureVisible('lead', 'services')).toBe(false)
  })

  it('lead: hides billing', () => {
    expect(isTierFeatureVisible('lead', 'billing')).toBe(false)
  })

  it('lead: hides invoices', () => {
    expect(isTierFeatureVisible('lead', 'invoices')).toBe(false)
  })

  it('lead: hides taxDocuments', () => {
    expect(isTierFeatureVisible('lead', 'taxDocuments')).toBe(false)
  })

  // Onboarding tier
  it('onboarding: shows documents', () => {
    expect(isTierFeatureVisible('onboarding', 'documents')).toBe(true)
  })

  it('onboarding: hides services', () => {
    expect(isTierFeatureVisible('onboarding', 'services')).toBe(false)
  })

  // Active tier
  it('active: shows services', () => {
    expect(isTierFeatureVisible('active', 'services')).toBe(true)
  })

  it('active: shows billing', () => {
    expect(isTierFeatureVisible('active', 'billing')).toBe(true)
  })

  it('active: shows deadlines', () => {
    expect(isTierFeatureVisible('active', 'deadlines')).toBe(true)
  })

  it('active: hides taxDocuments', () => {
    expect(isTierFeatureVisible('active', 'taxDocuments')).toBe(false)
  })

  // Full tier — everything visible
  it('full: shows everything', () => {
    const features = ['dashboard', 'services', 'billing', 'invoices', 'deadlines', 'taxDocuments', 'documents', 'customers']
    for (const f of features) {
      expect(isTierFeatureVisible('full', f)).toBe(true)
    }
  })

  // Null/undefined defaults to lead (most restricted)
  it('null tier defaults to lead', () => {
    expect(isTierFeatureVisible(null, 'services')).toBe(false)
    expect(isTierFeatureVisible(null, 'documents')).toBe(true)
  })

  // Unknown tier shows everything (safe fallback)
  it('unknown tier shows everything', () => {
    expect(isTierFeatureVisible('xyz', 'services')).toBe(true)
  })

  // Partner role — only partner features visible
  it('partner: shows referralManagement', () => {
    expect(isTierFeatureVisible('active', 'referralManagement', null, 'partner')).toBe(true)
  })

  it('partner: shows dashboard', () => {
    expect(isTierFeatureVisible('active', 'dashboard', null, 'partner')).toBe(true)
  })

  it('partner: shows chat', () => {
    expect(isTierFeatureVisible('active', 'chat', null, 'partner')).toBe(true)
  })

  it('partner: hides services', () => {
    expect(isTierFeatureVisible('active', 'services', null, 'partner')).toBe(false)
  })

  it('partner: hides billing', () => {
    expect(isTierFeatureVisible('active', 'billing', null, 'partner')).toBe(false)
  })

  it('partner: hides documents', () => {
    expect(isTierFeatureVisible('active', 'documents', null, 'partner')).toBe(false)
  })

  // Client referral management — visible at active/full tiers
  it('active client: shows referralManagement', () => {
    expect(isTierFeatureVisible('active', 'referralManagement')).toBe(true)
  })

  it('lead client: hides referralManagement', () => {
    expect(isTierFeatureVisible('lead', 'referralManagement')).toBe(false)
  })
})

describe('isPartnerPortal', () => {
  it('returns true for partner', () => {
    expect(isPartnerPortal('partner')).toBe(true)
  })

  it('returns false for client', () => {
    expect(isPartnerPortal('client')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isPartnerPortal(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isPartnerPortal(undefined)).toBe(false)
  })
})

describe('getDashboardVariant', () => {
  it('lead → offer', () => {
    expect(getDashboardVariant('lead')).toBe('offer')
  })

  it('onboarding → wizard', () => {
    expect(getDashboardVariant('onboarding')).toBe('wizard')
  })

  it('active → services', () => {
    expect(getDashboardVariant('active')).toBe('services')
  })

  it('full → full', () => {
    expect(getDashboardVariant('full')).toBe('full')
  })

  it('null → full', () => {
    expect(getDashboardVariant(null)).toBe('full')
  })
})
