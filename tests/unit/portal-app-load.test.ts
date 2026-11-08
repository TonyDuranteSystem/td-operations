/**
 * Client iPhone app, Step 2: who this login is for the app, and the facts gathered for it (dev job 056a70d0).
 * The helpers are faked, so these tests pin the DECISIONS: staff and partners are refused, a team member is scoped to one company, the
 * company cookies pick the company, each counter fails to 0 on its own, and the wizard link follows the selected onboarding.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadAppMeInput, resolveAppAudience, type AppLoadDeps } from '@/lib/portal-app/load'

const user = (over: Record<string, unknown> = {}) =>
  ({ id: 'u1', email: 'demo@example.com', app_metadata: { role: 'client', contact_id: 'c1' }, user_metadata: { full_name: 'Demo Client' }, ...over }) as never

const acct = (id: string, extra: Record<string, unknown> = {}) => ({ id, company_name: `Company ${id}`, account_type: 'Client', portal_tier: 'active', status: 'Active', ...extra })
const FLAGS_A1 = { billing: true, invoiceHub: true, invoices: true, documents: true } as never
const FLAGS_A2 = { billing: false, documents: true } as never
const CONTACT_ONLY = { documents: true } as never

function deps(over: Partial<Record<keyof AppLoadDeps, unknown>> = {}) {
  const calls: Record<string, unknown[][]> = {}
  const spy = <T>(name: string, fn: (...a: never[]) => T) => (...a: unknown[]) => { (calls[name] ??= []).push(a); return fn(...(a as never[])) }
  const d = {
    getAccounts: spy('getAccounts', async () => [acct('a1'), acct('a2')]),
    getInProgressFormations: spy('getInProgressFormations', async () => []),
    getInProgressOnboardings: spy('getInProgressOnboardings', async () => []),
    getTierByContact: spy('getTierByContact', async () => 'active'),
    getRoleByContact: spy('getRoleByContact', async () => null),
    resolveMode: spy('resolveMode', async () => ({ partnerCapable: false, clientCapable: true, dual: false, mode: 'client' })),
    getAccountById: spy('getAccountById', async (id: string) => acct(id)),
    resolveIdentity: spy('resolveIdentity', async () => ({ kind: 'none' })),
    getNavVisibility: spy('getNavVisibility', async (id: string) => (id === 'a2' ? FLAGS_A2 : FLAGS_A1)),
    getContactOnlyNavVisibility: spy('getContactOnlyNavVisibility', async () => CONTACT_ONLY),
    getUnreadChatCount: spy('getUnreadChatCount', async () => 3),
    getUnopenedDocsCount: spy('getUnopenedDocsCount', async () => 2),
    getToSignCount: spy('getToSignCount', async () => 1),
    getUnpaidInvoiceCount: spy('getUnpaidInvoiceCount', async () => 4),
    computeHasWizardPending: spy('computeHasWizardPending', async () => false),
    isAccountAdmin: spy('isAccountAdmin', async () => false),
    loadTranslations: spy('loadTranslations', async () => ({})),
    getBarPref: spy('getBarPref', async () => null),
    isPayEnabled: spy('isPayEnabled', async () => true),
    ...over,
  }
  return { d: d as unknown as AppLoadDeps, calls }
}
const cookies = (m: Record<string, string> = {}) => (name: string) => m[name]

describe('who the app is for', () => {
  it('refuses a staff login without reading anything about clients', async () => {
    const { d, calls } = deps()
    const r = await resolveAppAudience(user({ app_metadata: { role: 'admin' } }), cookies(), d)
    expect(r).toMatchObject({ ok: false, status: 403, code: 'NOT_A_CLIENT' })
    expect(calls.getAccounts).toBeUndefined()
  })
  it('refuses a login that is not linked to a client record', async () => {
    const { d } = deps()
    expect(await resolveAppAudience(user({ app_metadata: { role: 'client' } }), cookies(), d)).toMatchObject({ ok: false, code: 'NO_ACCESS' })
  })
  it('refuses a partner', async () => {
    const { d } = deps({ getRoleByContact: async () => 'partner' })
    expect(await resolveAppAudience(user(), cookies(), d)).toMatchObject({ ok: false, code: 'NOT_FOR_PARTNERS' })
  })
  it('refuses a person who is both a client and a partner while the portal is in partner mode, and serves them as a client in client mode', async () => {
    const partnerMode = deps({ getRoleByContact: async () => 'partner', resolveMode: async () => ({ partnerCapable: true, clientCapable: true, dual: true, mode: 'partner' }) })
    expect(await resolveAppAudience(user(), cookies({ portal_mode: 'partner' }), partnerMode.d)).toMatchObject({ ok: false, code: 'NOT_FOR_PARTNERS' })
    const clientMode = deps({ getRoleByContact: async () => 'partner', resolveMode: async () => ({ partnerCapable: true, clientCapable: true, dual: true, mode: 'client' }) })
    const r = await resolveAppAudience(user(), cookies(), clientMode.d)
    expect(r).toMatchObject({ ok: true, kind: 'client', effectiveRole: 'client' })
  })
  it("passes the portal's own mode cookie and 'has a company' to the mode check", async () => {
    const { d, calls } = deps()
    await resolveAppAudience(user(), cookies({ portal_mode: 'client' }), d)
    expect(calls.resolveMode[0]).toEqual(['c1', true, 'client'])
  })
  it('refuses a team login whose access was removed, and a team login whose company is gone', async () => {
    const tm = user({ app_metadata: { kind: 'team_member' } })
    expect(await resolveAppAudience(tm, cookies(), deps().d)).toMatchObject({ ok: false, code: 'NO_ACCESS' })
    const gone = deps({ resolveIdentity: async () => ({ kind: 'teammate', accountId: 'a9', capabilities: {}, displayName: 'T', email: null }), getAccountById: async () => null })
    expect(await resolveAppAudience(tm, cookies(), gone.d)).toMatchObject({ ok: false, code: 'NO_ACCESS' })
  })
})

describe('the facts gathered for a client', () => {
  it('uses the selected company: the cookie picks it, and the menu flags and counters are that company\'s', async () => {
    const { d, calls } = deps()
    const r = await loadAppMeInput(user(), cookies({ portal_account_id: 'a2' }), d)
    if (r.ok === false) throw new Error('refused')
    expect(calls.getNavVisibility[0]).toEqual(['a2'])
    expect(calls.getToSignCount[0][0]).toMatchObject({ selectedAccountId: 'a2', contactId: 'c1', userEmail: 'demo@example.com' })
    expect(calls.getUnpaidInvoiceCount[0]).toEqual(['a2'])
    expect(r.input.company).toEqual({ id: 'a2', name: 'Company a2' })
    expect(r.input.ctx).toMatchObject({ portalTier: 'active', hasCompany: true, isTeammate: false, portalRole: null })
    expect(r.input.counts).toEqual({ chat: 3, documents: 2, sign: 1, billing: 4 })
    expect(r.input.kind).toBe('client')
    expect(r.input.user).toEqual({ name: 'Demo Client', email: 'demo@example.com' })
  })
  it('falls back to the first company when the cookie names one the person does not have', async () => {
    const { d, calls } = deps()
    await loadAppMeInput(user(), cookies({ portal_account_id: 'someone-elses' }), d)
    expect(calls.getNavVisibility[0]).toEqual(['a1'])
  })
  it('a client with no company yet gets the contact-only menu flags and no company counters', async () => {
    const { d, calls } = deps({ getAccounts: async () => [], getTierByContact: async () => 'lead' })
    const r = await loadAppMeInput(user(), cookies(), d)
    if (r.ok === false) throw new Error('refused')
    expect(calls.getContactOnlyNavVisibility).toHaveLength(1)
    expect(calls.getNavVisibility).toBeUndefined()
    expect(calls.getToSignCount).toBeUndefined()
    expect(calls.getUnpaidInvoiceCount).toBeUndefined()
    expect(r.input.company).toBeNull()
    expect(r.input.ctx).toMatchObject({ portalTier: 'lead', hasCompany: false, canManageTeam: false })
    expect(r.input.counts).toMatchObject({ sign: 0, billing: 0 })
  })
  it('a company being formed is selected through its own cookie and drives the wizard link', async () => {
    const f = { id: 'form-1', sdId: 'sd1', label: 'New LLC', stage: 'formation', leadId: 'lead-1' }
    const { d, calls } = deps({ getAccounts: async () => [], getInProgressFormations: async () => [f] })
    const r = await loadAppMeInput(user(), cookies({ portal_formation: 'form-1' }), d)
    if (r.ok === false) throw new Error('refused')
    expect(r.input.ctx.portalTier).toBe('formation')
    expect(r.input.company).toEqual({ id: 'form-1', name: 'New LLC' })
    expect(r.input.selection).toMatchObject({ selectedFormationId: 'form-1' })
    expect(calls.computeHasWizardPending[0][0]).toMatchObject({ selectedAccountId: '', onboardingOfferId: undefined })
  })
  it('an onboarding in progress passes its offer to the wizard check', async () => {
    const o = { id: 'onb-1', label: 'Joining LLC', stage: 'onboarding', offerId: 'offer-9' }
    const { d, calls } = deps({ getAccounts: async () => [], getInProgressOnboardings: async () => [o] })
    const r = await loadAppMeInput(user(), cookies({ portal_onboarding: 'onb-1' }), d)
    if (r.ok === false) throw new Error('refused')
    expect(calls.computeHasWizardPending[0][0]).toMatchObject({ onboardingOfferId: 'offer-9', portalTier: 'onboarding' })
    expect(r.input.selection).toMatchObject({ selectedOnboardingId: 'onb-1' })
  })
  it('one failing counter becomes 0 and the answer still comes', async () => {
    const { d } = deps({
      getUnreadChatCount: async () => { throw new Error('dropped') },
      getToSignCount: async () => { throw new Error('dropped') },
    })
    const r = await loadAppMeInput(user(), cookies(), d)
    if (r.ok === false) throw new Error('refused')
    expect(r.input.counts).toEqual({ chat: 0, documents: 2, sign: 0, billing: 4 })
  })
  it('tells the answer whether the person is the company admin, their saved bar and the Pay switch', async () => {
    const { d } = deps({ isAccountAdmin: async () => true, getBarPref: async () => ['nav.chat', 'nav.overview'], isPayEnabled: async () => false })
    const r = await loadAppMeInput(user(), cookies(), d)
    if (r.ok === false) throw new Error('refused')
    expect(r.input.ctx.canManageTeam).toBe(true)
    expect(r.input.savedBar).toEqual(['nav.chat', 'nav.overview'])
    expect(r.input.payEnabled).toBe(false)
  })
  it('speaks the language of the login (the portal reads portal_language), English when none is set', async () => {
    const { d } = deps()
    const it = await loadAppMeInput(user({ user_metadata: { full_name: 'Demo', portal_language: 'it' } }), cookies(), d)
    if (it.ok === false) throw new Error('refused')
    expect(it.input.locale).toBe('it')
    expect(it.input.t('nav.overview')).toBe('Panoramica')
    const en = await loadAppMeInput(user({ user_metadata: { full_name: 'Demo' } }), cookies(), d)
    if (en.ok === false) throw new Error('refused')
    expect(en.input.locale).toBe('en')
    expect(en.input.t('nav.overview')).toBe('Overview')
  })
})

describe('the facts gathered for a team member', () => {
  const tm = user({ id: 'tm1', app_metadata: { kind: 'team_member' } })
  const identity = { kind: 'teammate', accountId: 'a5', capabilities: { chat: true, documents: true }, displayName: 'Tina Team', email: null }
  it('is scoped to ONE company, with the owner-granted permissions and no counters', async () => {
    const { d, calls } = deps({ resolveIdentity: async () => identity, getAccountById: async (id: string) => acct(id, { portal_tier: 'active' }) })
    const r = await loadAppMeInput(tm, cookies({ portal_account_id: 'a1' }), d)
    if (r.ok === false) throw new Error('refused')
    expect(calls.getNavVisibility[0]).toEqual(['a5'])
    expect(calls.getAccounts).toBeUndefined()
    expect(r.input.kind).toBe('teammate')
    expect(r.input.ctx).toMatchObject({ isTeammate: true, canManageTeam: false, hasCompany: true, teammateCapabilities: { chat: true, documents: true } })
    expect(r.input.counts).toEqual({ chat: 0, documents: 0, sign: 0, billing: 0 })
    expect(r.input.company).toEqual({ id: 'a5', name: 'Company a5' })
    expect(r.input.user).toEqual({ name: 'Tina Team', email: null })
  })
})

describe('the portal page shell and this module use the same helpers (drift guard)', () => {
  const layout = readFileSync('app/portal/layout.tsx', 'utf8')
  const load = readFileSync('lib/portal-app/load.ts', 'utf8')
  it('every helper the page shell uses to decide the menu is also used here, and the company cookies are the same', () => {
    const helpers = [
      'getPortalAccounts', 'getInProgressFormations', 'getInProgressOnboardings', 'getPortalTierByContact', 'getPortalRoleByContact',
      'resolvePortalMode', 'resolveSelectedEntity', 'getPortalNavVisibility', 'getContactOnlyNavVisibility', 'getUnreadChatCount',
      'getUnopenedDocsCount', 'getToSignCount', 'getUnpaidInvoiceCount', 'computeHasWizardPending', 'isAccountAdmin',
      'resolvePortalIdentity', 'getPortalAccountById',
    ]
    // a CALL or a dependency-injected use, not only the import line: the name must appear at least twice in each file
    const uses = (src: string, name: string) => src.split(name).length - 1
    for (const h of helpers) {
      expect(uses(layout, h), `layout uses ${h}`).toBeGreaterThanOrEqual(2)
      expect(uses(load, h), `load.ts uses ${h}`).toBeGreaterThanOrEqual(2)
    }
    for (const c of ['portal_account_id', 'portal_formation', 'portal_onboarding', 'portal_mode']) {
      expect(layout, `layout reads ${c}`).toContain(c)
      expect(load, `load.ts reads ${c}`).toContain(c)
    }
  })
})
