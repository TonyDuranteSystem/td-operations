import { describe, it, expect } from 'vitest'
import { validateApplyUrl, bankTileHref, summarizeBankActivity } from '@/lib/bank-referrals'

// The Bank Applications page became catalog-driven on 2026-07-27. These two
// pure helpers decide (a) whether a link Antonio types in the CRM is usable at
// all, and (b) where a client tile actually points. Both are client-facing:
// a bad link is a dead end for someone trying to open a bank account, and a
// wrong href silently drops referral attribution.

describe('validateApplyUrl — self-service banks', () => {
  it('accepts a plain https provider link', () => {
    expect(validateApplyUrl('https://mercury.com/', false)).toBeNull()
  })

  it('accepts a referral-tagged link with query params (Sokin / Revolut shape)', () => {
    expect(validateApplyUrl('https://www.sokin.com?pid=tonydurantellc', false)).toBeNull()
    expect(
      validateApplyUrl(
        'https://business.revolut.com/signup?promo=referabusiness&ext=f1ddcb7d&context=B2B_REFERRAL',
        false,
      ),
    ).toBeNull()
  })

  it('accepts a partner application form on a third-party domain (Verto typeform)', () => {
    expect(validateApplyUrl('https://platform043033.typeform.com/to/LCVzVO9f', false)).toBeNull()
  })

  it('rejects an internal path — the tracked redirect would send the client nowhere', () => {
    expect(validateApplyUrl('/portal/wizard?type=banking_relay', false)).toMatch(/valid http/i)
  })

  it('rejects a non-http scheme', () => {
    expect(validateApplyUrl('javascript:alert(1)', false)).toMatch(/valid http/i)
    expect(validateApplyUrl('ftp://example.com', false)).toMatch(/valid http/i)
  })

  it('rejects junk and empty input', () => {
    expect(validateApplyUrl('not a url', false)).toMatch(/valid http/i)
    expect(validateApplyUrl('', false)).toMatch(/required/i)
    expect(validateApplyUrl('   ', false)).toMatch(/required/i)
  })
})

describe('validateApplyUrl — managed ("we submit for you") banks', () => {
  it('accepts the internal intake form path', () => {
    expect(validateApplyUrl('/portal/wizard?type=banking_relay', true)).toBeNull()
    expect(validateApplyUrl('/portal/wizard?type=banking_payset', true)).toBeNull()
  })

  it('rejects an external link — a managed bank must open OUR form, not the bank site', () => {
    expect(validateApplyUrl('https://relayfi.com', true)).toMatch(/internal path/i)
  })

  it('still rejects empty input', () => {
    expect(validateApplyUrl('', true)).toMatch(/required/i)
  })

  it('tolerates surrounding whitespace', () => {
    expect(validateApplyUrl('  /portal/wizard?type=banking_relay  ', true)).toBeNull()
    expect(validateApplyUrl('  https://mercury.com/  ', false)).toBeNull()
  })
})

describe('summarizeBankActivity — drives the staff panel staying quiet', () => {
  it('reports no activity when the client has clicked nothing', () => {
    // The Nexo Agency case: 7 banks in the catalog, zero clicks. Panel must
    // collapse rather than render seven grey "Not Clicked" rows.
    const entries = ['relay', 'payset', 'mercury', 'sokin', 'revolut', 'airwallex', 'verto'].map(() => ({
      clicked_at: null,
    }))
    expect(summarizeBankActivity(entries)).toEqual({ total: 7, clickedCount: 0, hasActivity: false })
  })

  it('flags activity as soon as one bank is clicked', () => {
    const entries = [{ clicked_at: null }, { clicked_at: '2026-07-25T19:32:09Z' }, { clicked_at: null }]
    expect(summarizeBankActivity(entries)).toEqual({ total: 3, clickedCount: 1, hasActivity: true })
  })

  it('counts every clicked bank, not just the first', () => {
    const entries = [
      { clicked_at: '2026-07-01T00:00:00Z' },
      { clicked_at: '2026-07-02T00:00:00Z' },
      { clicked_at: null },
    ]
    expect(summarizeBankActivity(entries)).toMatchObject({ clickedCount: 2, hasActivity: true })
  })

  it('handles an empty catalog without claiming activity', () => {
    expect(summarizeBankActivity([])).toEqual({ total: 0, clickedCount: 0, hasActivity: false })
  })
})

describe('bankTileHref', () => {
  it('sends managed banks straight to the internal form — no tracked redirect', () => {
    expect(
      bankTileHref({ slug: 'relay', apply_url: '/portal/wizard?type=banking_relay', managed: true }),
    ).toBe('/portal/wizard?type=banking_relay')
  })

  it('routes self-service banks through the tracker, not the raw provider URL', () => {
    // Regression guard: the old hardcoded page linked straight to the provider,
    // which is how Sokin's ?pid referral tag stopped being credited.
    expect(
      bankTileHref({ slug: 'sokin', apply_url: 'https://www.sokin.com?pid=tonydurantellc', managed: false }),
    ).toBe('/portal/apply/bank/sokin')
    expect(
      bankTileHref({ slug: 'revolut', apply_url: 'https://business.revolut.com/signup?promo=x', managed: false }),
    ).toBe('/portal/apply/bank/revolut')
  })
})
