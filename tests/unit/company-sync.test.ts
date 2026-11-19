import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  COMPANY_SYNC_STORAGE_KEY,
  OWN_CHANGE_WINDOW_MS,
  announceCompanyChange,
  companyChangedElsewhere,
  companySignature,
  wasAnnouncedHere,
} from '@/lib/portal/company-sync'

describe('companySignature (the saved company as one comparable string)', () => {
  it('reads the three company cookies in a fixed order', () => {
    const jar = 'a=1; portal_onboarding=o1; portal_account_id=acc; other=x; portal_formation=f1'
    expect(companySignature(jar)).toBe('acc|f1|o1')
  })
  it('missing cookies are empty, an empty jar is all empty', () => {
    expect(companySignature('portal_account_id=acc')).toBe('acc||')
    expect(companySignature('')).toBe('||')
  })
  it('decodes percent-encoded values and ignores junk pieces', () => {
    expect(companySignature('portal_account_id=a%2Fb; ; =novalue; noequals')).toBe('a/b||')
  })
  it('a value with a bad escape is kept as it is, never throws', () => {
    expect(() => companySignature('portal_account_id=%E0%A4%A')).not.toThrow()
  })
  it('the first copy of a cookie wins, like the server', () => {
    expect(companySignature('portal_account_id=first; portal_account_id=second')).toBe('first||')
  })
})

describe('companyChangedElsewhere', () => {
  it('only a real change counts: a stale or odd cookie that has not changed never refreshes the tab', () => {
    expect(companyChangedElsewhere('personal||', 'personal||')).toBe(false)
    expect(companyChangedElsewhere('A||', 'B||')).toBe(true)
    expect(companyChangedElsewhere('A||', 'A|f1|')).toBe(true)
  })
})

describe('announceCompanyChange / wasAnnouncedHere', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('document', { cookie: 'portal_account_id=redstone' })
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    })
  })

  it('writes the new company plus a fresh stamp, so other tabs always get the event', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    announceCompanyChange()
    const first = store.get(COMPANY_SYNC_STORAGE_KEY)
    announceCompanyChange()
    const second = store.get(COMPANY_SYNC_STORAGE_KEY)
    expect(first?.startsWith('redstone||@')).toBe(true)
    expect(second).not.toBe(first)
    vi.restoreAllMocks()
  })

  it('this tab knows its own change for a short while, and only that change', () => {
    announceCompanyChange()
    const now = Date.now()
    expect(wasAnnouncedHere('redstone||', now)).toBe(true)
    expect(wasAnnouncedHere('hl||', now)).toBe(false)
    // a later change back to the same company, made in ANOTHER tab, must not be mistaken for this tab's own
    expect(wasAnnouncedHere('redstone||', now + OWN_CHANGE_WINDOW_MS + 1)).toBe(false)
  })

  it('blocked storage never throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(() => announceCompanyChange()).not.toThrow()
  })
})
