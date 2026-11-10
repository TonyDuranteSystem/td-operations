/**
 * Client iPhone app, Step 2: the bottom-bar rules and the "who am I" answer (dev job 056a70d0).
 * Pure functions, no database. The decisions under test were made by Antonio on 8 Nov 2026:
 *   - Chat is the only entry that always stays; the client picks the rest; at most five tabs;
 *   - a new client's standard bar is Overview, Chat, Documents, Invoices + (TD Billing if TD has invoiced the client, else Sign Documents);
 *   - My Company is not in the app;
 *   - an entry that stops being available drops out and the next standard entry takes its place.
 */
import { describe, it, expect } from 'vitest'
import {
  APP_BAR_SIZE,
  APP_EXCLUDED_KEYS,
  APP_LOCKED_KEY,
  effectiveBar,
  mergeBarChoice,
  menuBadge,
  standardBar,
  validateBar,
  type AppNavItem,
} from '@/lib/portal-app/bar'
import { assembleAppMe, type AppMeInput } from '@/lib/portal-app/assemble'
import { navLabelKey, resolveNavHref } from '@/lib/portal/nav-rules'
import { t as portalT } from '@/lib/portal/i18n'

const ACTIVE_WITH_BILLING = ['nav.overview', 'nav.chat', 'nav.referrals', 'nav.myClients', 'nav.invoices', 'nav.documents', 'nav.generateDocuments', 'nav.signDocuments', 'nav.tdBilling', 'nav.bankApplications', 'nav.requestService', 'nav.guide']
const ACTIVE_NO_BILLING = ACTIVE_WITH_BILLING.filter(k => k !== 'nav.tdBilling')

describe('the standard bar', () => {
  it("is Antonio's set for an active client with an invoice from Tony Durante", () => {
    expect(standardBar(ACTIVE_WITH_BILLING)).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling'])
  })
  it('puts Sign Documents in the fifth place when TD has not invoiced the client', () => {
    expect(standardBar(ACTIVE_NO_BILLING)).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.signDocuments'])
  })
  it('gives a lead their proposal and a client still being set up their Complete Setup step, with nothing to choose', () => {
    expect(standardBar(['nav.offer', 'nav.overview', 'nav.chat', 'nav.invoices', 'nav.requestService', 'nav.guide'], 'lead')).toEqual(['nav.overview', 'nav.chat', 'nav.offer', 'nav.invoices'])
    expect(standardBar(['nav.wizard', 'nav.overview', 'nav.chat', 'nav.documents', 'nav.signDocuments', 'nav.requestService', 'nav.guide'], 'onboarding')).toEqual(['nav.overview', 'nav.chat', 'nav.wizard', 'nav.documents', 'nav.signDocuments'])
  })
  it("keeps an ACTIVE client's bar exactly Antonio's set even while a service wizard is open", () => {
    const withWizard = ['nav.wizard', ...ACTIVE_WITH_BILLING]
    expect(standardBar(withWizard, 'active')).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling'])
    expect(effectiveBar(null, withWizard, 'active')).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling'])
  })
  it('never holds more than five entries and skips what the person cannot open', () => {
    expect(standardBar(ACTIVE_WITH_BILLING).length).toBeLessThanOrEqual(APP_BAR_SIZE)
    expect(standardBar([])).toEqual([])
    expect(standardBar(['nav.guide'])).toEqual([])
  })
})

describe('the bar a person sees', () => {
  it('is the standard bar until they choose', () => {
    expect(effectiveBar(null, ACTIVE_WITH_BILLING)).toEqual(standardBar(ACTIVE_WITH_BILLING))
    expect(effectiveBar([], ACTIVE_WITH_BILLING)).toEqual(standardBar(ACTIVE_WITH_BILLING))
  })

  it('shows their own choice, in their own order', () => {
    const saved = ['nav.chat', 'nav.signDocuments', 'nav.tdBilling', 'nav.overview', 'nav.referrals']
    expect(effectiveBar(saved, ACTIVE_WITH_BILLING)).toEqual(saved)
  })

  it('drops an entry that stopped being available and fills the place from the standard bar', () => {
    const saved = ['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling']
    // TD Billing goes away (no invoice from TD any more): Sign Documents, the next standard entry, takes the place.
    expect(effectiveBar(saved, ACTIVE_NO_BILLING)).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.signDocuments'])
  })

  it('brings the entry back when it returns (the saved choice is never rewritten)', () => {
    const saved = ['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling']
    expect(effectiveBar(saved, ACTIVE_NO_BILLING)).not.toContain('nav.tdBilling')
    expect(effectiveBar(saved, ACTIVE_WITH_BILLING)).toEqual(saved)
  })

  it('keeps a deliberately short bar short', () => {
    expect(effectiveBar(['nav.overview', 'nav.chat', 'nav.documents'], ACTIVE_WITH_BILLING)).toEqual(['nav.overview', 'nav.chat', 'nav.documents'])
  })

  it('always keeps Chat in the bar when the person has Chat, even if a saved bar lacks it', () => {
    const noChat = ['nav.overview', 'nav.documents', 'nav.invoices', 'nav.tdBilling', 'nav.signDocuments']
    const bar = effectiveBar(noChat, ACTIVE_WITH_BILLING)
    expect(bar).toContain(APP_LOCKED_KEY)
    expect(bar.length).toBe(5)
  })

  it('has no Chat when the person has no Chat (a team member without that permission)', () => {
    const avail = ACTIVE_WITH_BILLING.filter(k => k !== 'nav.chat')
    expect(effectiveBar(['nav.chat', 'nav.overview'], avail)).not.toContain('nav.chat')
    expect(standardBar(avail)).not.toContain('nav.chat')
  })

  it('ignores garbage and duplicates in a saved value', () => {
    const bar = effectiveBar(['nav.overview', 'nav.overview', 'nope', 7 as never, 'nav.chat'], ACTIVE_WITH_BILLING)
    expect(new Set(bar).size).toBe(bar.length)
    expect(bar).not.toContain('nope')
  })
})

describe('saving a bar', () => {
  it('accepts a bar of things the person can open that includes Chat', () => {
    expect(validateBar(['nav.overview', 'nav.chat', 'nav.signDocuments'], ACTIVE_WITH_BILLING)).toEqual({ ok: true, keys: ['nav.overview', 'nav.chat', 'nav.signDocuments'] })
  })
  it('refuses a bar without Chat when the person has Chat', () => {
    const r = validateBar(['nav.overview', 'nav.documents'], ACTIVE_WITH_BILLING)
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.code).toBe('BAR_NEEDS_CHAT')
  })
  it('refuses more than five, none, duplicates, unknown entries and My Company', () => {
    expect(validateBar(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e', 'f'])).toMatchObject({ ok: false, code: 'BAR_SIZE' })
    expect(validateBar([], ACTIVE_WITH_BILLING)).toMatchObject({ ok: false, code: 'BAR_SIZE' })
    expect(validateBar(['nav.chat', 'nav.chat'], ACTIVE_WITH_BILLING)).toMatchObject({ ok: false, code: 'BAR_DUPLICATE' })
    expect(validateBar(['nav.chat', 'nav.tdBilling'], ACTIVE_NO_BILLING)).toMatchObject({ ok: false, code: 'BAR_NOT_AVAILABLE' })
    expect(validateBar(['nav.chat', 'nav.myCompany'], [...ACTIVE_WITH_BILLING, 'nav.myCompany'])).toMatchObject({ ok: false, code: 'BAR_NOT_AVAILABLE' })
  })
  it('refuses anything that is not a list of text', () => {
    expect(validateBar('nav.chat', ACTIVE_WITH_BILLING)).toMatchObject({ ok: false, code: 'BAR_INVALID' })
    expect(validateBar(null, ACTIVE_WITH_BILLING)).toMatchObject({ ok: false, code: 'BAR_INVALID' })
    expect(validateBar([1, 2], ACTIVE_WITH_BILLING)).toMatchObject({ ok: false, code: 'BAR_INVALID' })
  })
  it('lets a person without Chat save a bar without it', () => {
    const avail = ACTIVE_WITH_BILLING.filter(k => k !== 'nav.chat')
    expect(validateBar(['nav.overview', 'nav.documents'], avail)).toEqual({ ok: true, keys: ['nav.overview', 'nav.documents'] })
  })
})

describe('the number on the Menu button', () => {
  const items: AppNavItem[] = [
    { key: 'nav.chat', path: '/portal/chat', label: 'Chat', badge: 2 },
    { key: 'nav.signDocuments', path: '/portal/sign', label: 'Sign Documents', badge: 1 },
    { key: 'nav.tdBilling', path: '/portal/billing', label: 'TD Billing', badge: 3 },
    { key: 'nav.documents', path: '/portal/documents', label: 'Documents', badge: 0 },
  ]
  it('adds up only the entries that are NOT in the bar', () => {
    expect(menuBadge(items, ['nav.chat', 'nav.tdBilling'])).toBe(1)
    expect(menuBadge(items, ['nav.chat'])).toBe(4)
    expect(menuBadge(items, ['nav.chat', 'nav.signDocuments', 'nav.tdBilling', 'nav.documents'])).toBe(0)
  })
})

// ───────────────────────── the whole answer ─────────────────────────
const words = (key: string) => portalT(key, 'en')

function input(over: Partial<AppMeInput> & { ctx: AppMeInput['ctx'] }): AppMeInput {
  return {
    user: { name: 'Demo Client', email: 'demo@example.com' },
    kind: 'client',
    locale: 'en',
    t: words,
    selection: { inProgress: [], inProgressOnboardings: [] },
    company: { id: 'a1', name: 'Demo Company LLC' },
    counts: { chat: 2, documents: 0, sign: 1, billing: 1 },
    savedBar: null,
    payEnabled: true,
    ...over,
  }
}

const ACTIVE_FLAGS = { billing: true, invoices: true, customers: true, invoiceHub: true, documentGenerator: true, pendingSignatures: true } as never

describe('the "who am I" answer', () => {
  it('lists what an active client can open, in menu order, without My Company, with words and badges', () => {
    const me = assembleAppMe(input({ ctx: { portalTier: 'active', hasCompany: true, navVisibility: ACTIVE_FLAGS } }))
    const keys = me.items.map(i => i.key)
    expect(keys).toEqual(['nav.overview', 'nav.chat', 'nav.referrals', 'nav.myClients', 'nav.invoices', 'nav.documents', 'nav.generateDocuments', 'nav.signDocuments', 'nav.tdBilling', 'nav.bankApplications', 'nav.requestService', 'nav.guide'])
    for (const k of APP_EXCLUDED_KEYS) expect(keys).not.toContain(k)
    // The app's bar and menu say plainly "Invoices" (approved design), even with the hub on; the website's sidebar keeps "Customers & Invoices".
    expect(me.items.find(i => i.key === 'nav.invoices')?.label).toBe('Invoices')
    expect(me.items.find(i => i.key === 'nav.chat')).toMatchObject({ path: '/portal/chat', badge: 2 })
    expect(me.items.find(i => i.key === 'nav.signDocuments')?.badge).toBe(1)
    expect(me.items.find(i => i.key === 'nav.tdBilling')?.badge).toBe(1)
    expect(me.bar).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling'])
    expect(me.lockedKey).toBe('nav.chat')
    expect(me.maxBarSize).toBe(5)
    // Not in the bar: Sign Documents (1) -> the Menu button says 1.
    expect(me.menuBadge).toBe(1)
    expect(me.payEnabled).toBe(true)
  })

  it('names the invoices entry plainly when the invoices hub is off, and Complete Setup / Bank Applications by their own words', () => {
    const noHub = assembleAppMe(input({ ctx: { portalTier: 'active', hasCompany: true, navVisibility: { invoices: true, customers: true, invoiceHub: false } as never } }))
    expect(noHub.items.find(i => i.key === 'nav.invoices')?.label).toBe(portalT('nav.invoices', 'en'))
    expect(navLabelKey({ key: 'nav.wizard' }, { invoicesHubOn: true })).toBe('sidebar.completeSetup')
    expect(navLabelKey({ key: 'nav.bankApplications' }, { invoicesHubOn: false })).toBe('sidebar.bankApplications')
    expect(navLabelKey({ key: 'nav.invoices' }, { invoicesHubOn: true })).toBe('nav.invoicesHub')
    expect(navLabelKey({ key: 'nav.overview' }, { invoicesHubOn: true })).toBe('nav.overview')
  })

  it('speaks Italian when the person does', () => {
    const me = assembleAppMe(input({ locale: 'it', t: key => portalT(key, 'it'), ctx: { portalTier: 'active', hasCompany: true, navVisibility: ACTIVE_FLAGS } }))
    expect(me.items.find(i => i.key === 'nav.overview')?.label).toBe(portalT('nav.overview', 'it'))
    expect(me.items.find(i => i.key === 'nav.overview')?.label).not.toBe(portalT('nav.overview', 'en'))
  })

  it('gives a lead their proposal first and a short bar', () => {
    const me = assembleAppMe(input({ company: null, counts: { chat: 0, documents: 0, sign: 0, billing: 0 }, ctx: { portalTier: 'lead', hasCompany: false, navVisibility: { invoices: false } as never } }))
    expect(me.items.map(i => i.key)).toEqual(['nav.offer', 'nav.overview', 'nav.chat', 'nav.invoices', 'nav.requestService', 'nav.guide'])
    expect(me.bar).toEqual(['nav.overview', 'nav.chat', 'nav.offer', 'nav.invoices'])
    expect(me.menuBadge).toBe(0)
  })

  it('points Complete Setup at the onboarding the client has selected', () => {
    const me = assembleAppMe(input({
      ctx: { portalTier: 'onboarding', hasCompany: true, hasWizardPending: true, navVisibility: { documents: true, pendingSignatures: true } as never },
      selection: { selectedOnboardingId: 'o1', inProgress: [], inProgressOnboardings: [{ id: 'o1', label: 'Joining LLC', stage: 'onboarding', offerId: 'offer-9' } as never] },
    }))
    expect(me.items.find(i => i.key === 'nav.wizard')).toMatchObject({ label: 'Complete Setup', path: '/portal/wizard?type=onboarding&offer=offer-9' })
  })

  it('resolves the wizard link the way the side menu does', () => {
    const inProgress = [{ id: 'f1', sdId: 's', label: 'x', stage: 'formation', leadId: 'lead-1' }, { id: 'f2', sdId: 's', label: 'y', stage: 'formation', offerId: 'offer-2' }] as never[]
    expect(resolveNavHref({ key: 'nav.wizard', href: '/portal/wizard' }, { selectedFormationId: 'f1', inProgress, inProgressOnboardings: [] })).toBe('/portal/wizard?type=formation&lead=lead-1')
    expect(resolveNavHref({ key: 'nav.wizard', href: '/portal/wizard' }, { selectedFormationId: 'f2', inProgress, inProgressOnboardings: [] })).toBe('/portal/wizard?type=formation&offer=offer-2')
    expect(resolveNavHref({ key: 'nav.wizard', href: '/portal/wizard' }, { inProgress, inProgressOnboardings: [] })).toBe('/portal/wizard')
    expect(resolveNavHref({ key: 'nav.documents', href: '/portal/documents' }, { selectedFormationId: 'f1', inProgress, inProgressOnboardings: [] })).toBe('/portal/documents')
  })

  it('shows a team member only what their permissions allow, with Chat only if granted', () => {
    const withChat = assembleAppMe(input({ kind: 'teammate', counts: { chat: 0, documents: 0, sign: 0, billing: 0 }, ctx: { portalTier: 'active', hasCompany: true, isTeammate: true, teammateCapabilities: { chat: true, documents: true }, navVisibility: ACTIVE_FLAGS } }))
    // (Generate Documents rides on the same 'documents' permission for a team member, exactly as in the website's menu.)
    expect(withChat.items.map(i => i.key)).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.generateDocuments', 'nav.guide'])
    expect(withChat.lockedKey).toBe('nav.chat')
    const noChat = assembleAppMe(input({ kind: 'teammate', counts: { chat: 0, documents: 0, sign: 0, billing: 0 }, ctx: { portalTier: 'active', hasCompany: true, isTeammate: true, teammateCapabilities: { documents: true }, navVisibility: ACTIVE_FLAGS } }))
    expect(noChat.items.map(i => i.key)).toEqual(['nav.overview', 'nav.documents', 'nav.generateDocuments', 'nav.guide'])
    expect(noChat.lockedKey).toBeNull()
  })

  it('applies a saved choice, drops what is gone, and carries the Pay switch', () => {
    const me = assembleAppMe(input({
      ctx: { portalTier: 'active', hasCompany: true, navVisibility: { ...(ACTIVE_FLAGS as object), billing: false } as never },
      savedBar: ['nav.chat', 'nav.tdBilling', 'nav.documents', 'nav.referrals', 'nav.overview'],
      payEnabled: false,
    }))
    expect(me.bar).toEqual(['nav.chat', 'nav.documents', 'nav.referrals', 'nav.overview', 'nav.invoices'])
    expect(me.payEnabled).toBe(false)
  })
})

describe('mergeBarChoice — a save in one company does not erase the bar set up in another', () => {
  const here = ['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.signDocuments', 'nav.referrals']
  it('keeps earlier choices this company cannot show, behind the submitted ones', () => {
    expect(mergeBarChoice(['nav.overview', 'nav.chat', 'nav.documents'], ['nav.overview', 'nav.chat', 'nav.tdBilling', 'nav.documents'], here))
      .toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.tdBilling'])
  })
  it('drops an earlier choice this company COULD show but the person left out (removed on purpose)', () => {
    expect(mergeBarChoice(['nav.overview', 'nav.chat'], ['nav.overview', 'nav.chat', 'nav.referrals'], here)).toEqual(['nav.overview', 'nav.chat'])
  })
  it('never goes past five, and the submitted entries always win', () => {
    const five = ['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.signDocuments']
    expect(mergeBarChoice(five, ['nav.tdBilling'], here)).toEqual(five)
    expect(mergeBarChoice(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices'], ['nav.tdBilling', 'nav.bankApplications'], here))
      .toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices', 'nav.tdBilling'])
  })
  it('no earlier choice, a repeat, My Company or something that is not text change nothing', () => {
    expect(mergeBarChoice(['nav.chat'], null, here)).toEqual(['nav.chat'])
    expect(mergeBarChoice(['nav.chat', 'nav.tdBilling'], ['nav.tdBilling', 'nav.myCompany', 42 as unknown as string], here)).toEqual(['nav.chat', 'nav.tdBilling'])
  })
  it('the other company then sees its own choice back in full', () => {
    const acme = ['nav.overview', 'nav.chat', 'nav.documents', 'nav.referrals', 'nav.tdBilling', 'nav.invoices']
    const stored = mergeBarChoice(['nav.overview', 'nav.chat', 'nav.documents'], ['nav.overview', 'nav.chat', 'nav.referrals', 'nav.documents', 'nav.tdBilling'], ['nav.overview', 'nav.chat', 'nav.documents', 'nav.invoices'])
    expect(stored).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.referrals', 'nav.tdBilling'])
    expect(effectiveBar(stored, acme)).toEqual(stored)
  })
})
