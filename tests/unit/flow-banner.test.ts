import { describe, it, expect } from 'vitest'
import { flowStageBannerState, flowBannerHasAction } from '@/lib/tax/flow-banner'

describe('flowStageBannerState', () => {
  it('maps Sent for Signature and Tax Return Prepared to sign', () => {
    expect(flowStageBannerState('Sent for Signature')).toBe('sign')
    expect(flowStageBannerState('Tax Return Prepared')).toBe('sign')
  })

  it('maps Wizard Available to complete_form', () => {
    expect(flowStageBannerState('Wizard Available')).toBe('complete_form')
  })

  it('maps Data Submitted and Under Review to under_review (no action)', () => {
    expect(flowStageBannerState('Data Submitted')).toBe('under_review')
    expect(flowStageBannerState('Under Review')).toBe('under_review')
    expect(flowBannerHasAction('under_review')).toBe(false)
  })

  it('maps Review Completed to preparing', () => {
    expect(flowStageBannerState('Review Completed')).toBe('preparing')
  })

  it('maps Revision Requested to revision_requested (with action)', () => {
    expect(flowStageBannerState('Revision Requested')).toBe('revision_requested')
    expect(flowBannerHasAction('revision_requested')).toBe(true)
  })

  it('maps Signed / filed / completed to their status states', () => {
    expect(flowStageBannerState('Signed')).toBe('signed')
    expect(flowStageBannerState('Filed with IRS')).toBe('filed')
    expect(flowStageBannerState('IRS Receipt Uploaded')).toBe('filed')
    expect(flowStageBannerState('Completed')).toBe('completed')
  })

  it('returns null for early/billing/unknown stages (fall through)', () => {
    expect(flowStageBannerState('Extension Due')).toBeNull()
    expect(flowStageBannerState('Awaiting 2nd Payment')).toBeNull()
    expect(flowStageBannerState('Some Legacy Stage')).toBeNull()
    expect(flowStageBannerState(null)).toBeNull()
    expect(flowStageBannerState(undefined)).toBeNull()
    expect(flowStageBannerState('')).toBeNull()
  })

  it('only sign / complete_form / revision_requested carry an action', () => {
    expect(flowBannerHasAction('sign')).toBe(true)
    expect(flowBannerHasAction('complete_form')).toBe(true)
    expect(flowBannerHasAction('signed')).toBe(false)
    expect(flowBannerHasAction('preparing')).toBe(false)
    expect(flowBannerHasAction('filed')).toBe(false)
    expect(flowBannerHasAction('completed')).toBe(false)
  })
})
