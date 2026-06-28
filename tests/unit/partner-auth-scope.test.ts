import { describe, it, expect } from 'vitest'
import { hasAnyPartnerScope } from '@/lib/partner-auth'

describe('hasAnyPartnerScope (login-admission gate)', () => {
  it('admits a partner with any non-empty scope', () => {
    expect(hasAnyPartnerScope(['td_communication'])).toBe(true)
    expect(hasAnyPartnerScope(['some_future_scope'])).toBe(true)
    expect(hasAnyPartnerScope(['a', 'b'])).toBe(true)
  })

  it('rejects an empty or missing scope', () => {
    expect(hasAnyPartnerScope([])).toBe(false)
    expect(hasAnyPartnerScope(null)).toBe(false)
    expect(hasAnyPartnerScope(undefined)).toBe(false)
  })

  it('rejects non-array inputs (default-deny)', () => {
    expect(hasAnyPartnerScope('td_communication')).toBe(false)
    expect(hasAnyPartnerScope({})).toBe(false)
    expect(hasAnyPartnerScope(1)).toBe(false)
  })
})
