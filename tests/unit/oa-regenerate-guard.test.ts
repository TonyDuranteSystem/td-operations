import { describe, it, expect } from 'vitest'
import { hasCollectedSignatures } from '@/lib/portal/oa-regenerate-guard'

// Regression pin: re-generating an OA hard-deletes the prior agreement AND its
// oa_signatures rows. Anything that returns FALSE here gets deleted, so a false
// negative on a partially-signed MMLLC destroys executed client signatures.
describe('hasCollectedSignatures', () => {
  it('blocks a fully signed OA', () => {
    expect(hasCollectedSignatures({ status: 'signed' })).toBe(true)
  })

  it('blocks a partially signed MMLLC OA — the bug this guard exists for', () => {
    // 2 of 3 members signed: status is NOT 'signed', so the old
    // `status === 'signed'` guard let this through and deleted both signatures.
    expect(hasCollectedSignatures({ status: 'partially_signed', signed_count: 2 })).toBe(true)
  })

  it('blocks on signed_count alone when status has not caught up yet', () => {
    expect(hasCollectedSignatures({ status: 'sent', signed_count: 1 })).toBe(true)
  })

  it('allows deleting an untouched sent OA', () => {
    expect(hasCollectedSignatures({ status: 'sent', signed_count: 0 })).toBe(false)
  })

  it('allows deleting a draft and a viewed OA', () => {
    expect(hasCollectedSignatures({ status: 'draft', signed_count: 0 })).toBe(false)
    expect(hasCollectedSignatures({ status: 'viewed', signed_count: 0 })).toBe(false)
  })

  it('treats a null/absent signed_count as zero, not as a signature', () => {
    expect(hasCollectedSignatures({ status: 'sent', signed_count: null })).toBe(false)
    expect(hasCollectedSignatures({ status: 'sent' })).toBe(false)
  })

  it('does not crash on a null status', () => {
    expect(hasCollectedSignatures({ status: null })).toBe(false)
  })
})
