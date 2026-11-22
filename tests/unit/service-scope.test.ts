/**
 * The service-scoped portal login (Antonio, 22 Nov 2026, dev job 6f555c9f): the pure rule in lib/portal/service-scope.ts, the guards on the pages
 * (the menu hides an entry AND the page refuses it when its address is typed), and the catalog data that adds an entry back for a bought service.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVICE_SCOPED_HIDDEN_NAV_KEYS,
  SERVICE_SCOPED_PAGE_KEYS,
  isServiceScopedLogin,
  portalNavKeysOf,
  scopedNavKeyHidden,
} from '@/lib/portal/service-scope'
import { MAIN_NAV_ITEMS } from '@/lib/portal/nav-rules'

describe('isServiceScopedLogin', () => {
  it('is true for a "One-Time" company login', () => {
    expect(isServiceScopedLogin({ accountType: 'One-Time', hasCompany: true })).toBe(true)
  })
  it('is false for annual management ("Client") or an empty label', () => {
    expect(isServiceScopedLogin({ accountType: 'Client', hasCompany: true })).toBe(false)
    expect(isServiceScopedLogin({ accountType: null, hasCompany: true })).toBe(false)
  })
  it('with NO company: true only at the active level (a one-time individual); a lead or a person being set up is not limited', () => {
    expect(isServiceScopedLogin({ hasCompany: false, portalTier: 'active' })).toBe(true)
    for (const t of ['lead', 'formation', 'onboarding', undefined, null, 'not-a-tier']) expect(isServiceScopedLogin({ hasCompany: false, portalTier: t as string | null | undefined })).toBe(false)
    expect(isServiceScopedLogin({ accountType: 'One-Time', hasCompany: false })).toBe(false)
  })
  it('is never true for a team member or a partner (they follow their own rules)', () => {
    expect(isServiceScopedLogin({ accountType: 'One-Time', hasCompany: true, isTeammate: true })).toBe(false)
    expect(isServiceScopedLogin({ accountType: 'One-Time', hasCompany: true, portalRole: 'partner' })).toBe(false)
  })
})

describe('scopedNavKeyHidden', () => {
  it('hides every entry in the hidden list, and nothing else', () => {
    for (const k of SERVICE_SCOPED_HIDDEN_NAV_KEYS) expect(scopedNavKeyHidden(k)).toBe(true)
    for (const k of ['nav.overview', 'nav.chat', 'nav.documents', 'nav.signDocuments', 'nav.tdBilling', 'nav.guide']) expect(scopedNavKeyHidden(k)).toBe(false)
  })
  it('a bought service adds back exactly the entry its catalog row names', () => {
    expect(scopedNavKeyHidden('nav.bankApplications', ['nav.bankApplications'])).toBe(false)
    expect(scopedNavKeyHidden('nav.referrals', ['nav.bankApplications'])).toBe(true)
    expect(scopedNavKeyHidden('nav.bankApplications', [])).toBe(true)
    expect(scopedNavKeyHidden('nav.bankApplications', null)).toBe(true)
  })
  it('every hidden entry is a real menu entry (a typo would silently hide nothing)', () => {
    const real = MAIN_NAV_ITEMS.map((i) => i.key)
    for (const k of SERVICE_SCOPED_HIDDEN_NAV_KEYS) expect(real).toContain(k)
  })
})

describe('portalNavKeysOf (the catalog row of a service)', () => {
  it('reads the entries the service adds back', () => {
    expect(portalNavKeysOf({ portal_nav_keys: ['nav.bankApplications'] })).toEqual(['nav.bankApplications'])
  })
  it('ignores anything that is not a known hidden entry, a bad shape, or a missing key', () => {
    expect(portalNavKeysOf({ portal_nav_keys: ['nav.overview', 'nav.bankApplications', 3, null] })).toEqual(['nav.bankApplications'])
    expect(portalNavKeysOf({ portal_nav_keys: 'nav.bankApplications' })).toEqual([])
    expect(portalNavKeysOf({})).toEqual([])
    expect(portalNavKeysOf(null)).toEqual([])
    expect(portalNavKeysOf(undefined)).toEqual([])
  })
})

describe('the pages refuse what the menu hides', () => {
  // each page: the file, the guard key it must use
  const GUARDED: Array<[string, keyof typeof SERVICE_SCOPED_PAGE_KEYS]> = [
    ['app/portal/referrals/page.tsx', 'referrals'],
    ['app/portal/documents/generate/page.tsx', 'generateDocuments'],
    ['app/portal/company/page.tsx', 'company'],
    ['app/portal/banks/page.tsx', 'banks'],
    ['app/portal/services/request/page.tsx', 'requestService'],
    ['app/portal/customers/page.tsx', 'customers'],
    ['app/portal/customers/new/page.tsx', 'customers'],
    ['app/portal/invoices/new/page.tsx', 'customers'],
    ['app/portal/team/page.tsx', 'team'],
    ['app/portal/team/approvals/page.tsx', 'team'],
  ]
  it.each(GUARDED)('%s calls the guard with its own key', (file, key) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    expect(src).toContain('redirectIfHiddenForServiceScope(user, SERVICE_SCOPED_PAGE_KEYS.' + key + ')')
    // the guard comes right after the login check, before the page reads anything
    expect(src.indexOf('redirectIfHiddenForServiceScope(user')).toBeGreaterThan(src.indexOf('getUser()'))
  })
  it('every hidden entry has a guarded page', () => {
    const used = new Set(GUARDED.map(([, k]) => SERVICE_SCOPED_PAGE_KEYS[k] as string))
    for (const k of SERVICE_SCOPED_HIDDEN_NAV_KEYS) expect(used.has(k), k).toBe(true)
  })
  it('the guard fails OPEN on a lookup error (never locks a client out of a page they are entitled to)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/portal/service-scope-server.ts'), 'utf8')
    expect(src).toMatch(/catch \{\s*return\s*\}/)
    expect(src).toContain("redirect('/portal')")
  })
})

describe('the catalog data that adds an entry back', () => {
  it('only Banking adds Bank Applications back, once, without overwriting an edited row', () => {
    const sql = readFileSync(join(process.cwd(), 'scripts/migrations/20261122-2000-service-scope-portal-nav-keys.sql'), 'utf8')
    expect(sql).toContain("slug = 'banking'")
    expect(sql).toContain('["nav.bankApplications"]')
    expect(sql).toContain("NOT (COALESCE(metadata, '{}'::jsonb) ? 'portal_nav_keys')")
    expect(sql).not.toMatch(/DROP\s|DELETE\s|ALTER TABLE/i)
  })
})
