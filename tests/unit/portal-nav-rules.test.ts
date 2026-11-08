/**
 * The client portal's menu rules moved out of the side menu into `lib/portal/nav-rules.ts` (client iPhone app, step 1,
 * dev job 056a70d0) so the website and the app read the SAME answer. Moving them must not change what any login sees.
 *
 * PARITY: the `legacy*` code below is the old rule and the old lists, copied word for word from
 * `components/portal/portal-sidebar.tsx` as it was on main at bebf4f4ce (icons removed). Every combination of login
 * kind is run through the old rule and the new module, and the resulting menus must be identical. Do not "tidy" the
 * legacy copy: its whole value is that it is the old behaviour.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isTierFeatureVisible, isPartnerPortal } from '@/lib/portal/tier-config'
import { hubAccess } from '@/lib/portal/invoice-hub'
import { hasCapability, teammateNavCapability, TEAM_CAPABILITIES, type TeamCapability } from '@/lib/portal/team/capabilities'
import {
  MAIN_NAV_ITEMS,
  TIER_TOP_NAV_ITEMS,
  PARTNER_NAV_ITEMS,
  BOTTOM_NAV_ITEMS,
  PERSONAL_INVOICES_NAV_ITEM,
  isNavItemVisible,
  showCompaniesSection,
  visibleMainItems,
  visiblePartnerItems,
  visibleTierTopItems,
  type NavRuleContext,
  type PortalNavItemDef,
} from '@/lib/portal/nav-rules'

// ───────────────────────── the OLD code, frozen ─────────────────────────
interface LegacyItem {
  key: string
  href: string
  visibilityKey?: string
  tierOnly?: string[]
  wizardDynamic?: boolean
  partnerOnly?: boolean
  teamAdminOnly?: boolean
  hintKey?: string
  needsCompany?: boolean
}

const legacyMainItems: LegacyItem[] = [
  { key: 'nav.overview', href: '/portal' },
  { key: 'nav.chat', href: '/portal/chat' },
  { key: 'nav.referrals', href: '/portal/referrals' },
  { key: 'nav.myClients', href: '/portal/customers', visibilityKey: 'customers', needsCompany: true },
  { key: 'nav.invoices', href: '/portal/invoices', visibilityKey: 'invoices', needsCompany: true },
  { key: 'nav.documents', href: '/portal/documents', needsCompany: true },
  { key: 'nav.team', href: '/portal/team', teamAdminOnly: true, needsCompany: true },
  { key: 'nav.generateDocuments', href: '/portal/documents/generate', visibilityKey: 'documentGenerator', needsCompany: true },
  { key: 'nav.signDocuments', href: '/portal/sign', needsCompany: true },
  { key: 'nav.tdBilling', href: '/portal/billing', visibilityKey: 'billing', needsCompany: true },
  { key: 'nav.bankApplications', href: '/portal/banks', needsCompany: true },
  { key: 'nav.requestService', href: '/portal/services/request' },
  { key: 'nav.myCompany', href: '/portal/company', needsCompany: true },
]
const legacyPersonalInvoicesItem: LegacyItem = { key: 'nav.invoices', href: '/portal/invoices', hintKey: 'invoicesPersonal' }
const legacyTierTopItems: LegacyItem[] = [
  { key: 'nav.offer', href: '/portal/offer', tierOnly: ['lead'] },
  { key: 'nav.wizard', href: '/portal/wizard', tierOnly: ['onboarding'], wizardDynamic: true },
]
const legacyPartnerItems: LegacyItem[] = [
  { key: 'nav.partnerClients', href: '/portal/partner/clients', partnerOnly: true },
  { key: 'nav.partnerReferrals', href: '/portal/partner/referrals', partnerOnly: true },
  { key: 'nav.partnerNewRequest', href: '/portal/partner/new-request', partnerOnly: true },
  { key: 'nav.partnerInvoices', href: '/portal/partner/invoices', partnerOnly: true },
  { key: 'nav.chat', href: '/portal/chat', partnerOnly: true },
]
const legacyBottomItems: LegacyItem[] = [{ key: 'nav.guide', href: '/portal/guide' }]

interface LegacyProps {
  navVisibility?: Record<string, boolean>
  portalTier?: string
  accountType?: string | null
  portalRole?: string | null
  hasWizardPending?: boolean
  canManageTeam: boolean
  isTeammate: boolean
  teammateCapabilities: Record<string, boolean>
  accountsLength: number
}

/** The old `PortalSidebar` body: hubRule, isItemVisible and the three visible lists. */
function legacyMenu(p: LegacyProps) {
  const { navVisibility, portalTier, accountType, portalRole, hasWizardPending, canManageTeam, isTeammate, teammateCapabilities } = p
  const hubRule = hubAccess({
    hubOn: !!navVisibility?.invoiceHub,
    hasAccount: true,
    isClient: !isTeammate,
    teammateCapabilities: isTeammate ? (teammateCapabilities as Partial<Record<TeamCapability, boolean>>) : null,
  })
  const isPartner = isPartnerPortal(portalRole)
  const isItemVisible = (item: LegacyItem): boolean => {
    if (item.teamAdminOnly) return canManageTeam
    if (isTeammate) {
      const cap = teammateNavCapability(item.key)
      if (cap === null) return false
      if (cap === 'always') return true
      if (item.key === 'nav.myClients' && hubRule.customers && hubRule.setup) return false
      return hasCapability(teammateCapabilities as Partial<Record<TeamCapability, boolean>>, cap)
    }
    if (item.partnerOnly) return isPartner

    if (isPartner) {
      if (item.tierOnly) return false
      if (['nav.myCompany', 'nav.documents', 'nav.tdBilling', 'nav.signDocuments', 'nav.invoices', 'nav.myClients', 'nav.businessSettings'].includes(item.key)) return false
      if (item.key === 'nav.referrals') return isTierFeatureVisible(portalTier || null, 'referralManagement', accountType, portalRole)
      return true
    }

    if (item.key === 'nav.tdBilling') {
      if (!isTierFeatureVisible(portalTier || null, 'billing', accountType, portalRole)) return false
      return navVisibility?.billing ?? false
    }
    if (item.key === 'nav.myCompany') {
      return isTierFeatureVisible(portalTier || null, 'services', accountType, portalRole)
    }
    if (item.key === 'nav.bankApplications') {
      return (portalTier || 'lead') === 'active'
    }
    if (item.key === 'nav.referrals') {
      return isTierFeatureVisible(portalTier || null, 'referralManagement', accountType, portalRole)
    }
    if (item.key === 'nav.signDocuments') {
      return isTierFeatureVisible(portalTier || null, 'pendingSignatures', accountType, portalRole)
    }
    if (item.visibilityKey) {
      if (!isTierFeatureVisible(portalTier || null, item.visibilityKey, accountType, portalRole)) return false
      return navVisibility?.[item.visibilityKey] ?? false
    }
    if (!item.tierOnly) return true
    if (item.wizardDynamic && hasWizardPending) return true
    return item.tierOnly.includes(portalTier || 'lead')
  }
  const visibleTierTop = legacyTierTopItems.filter(isItemVisible)
  const visiblePartner = legacyPartnerItems.filter(isItemVisible)
  const showCompanies = !isPartner && p.accountsLength > 0
  const visibleMain = isPartner
    ? []
    : legacyMainItems
        .map(item => (item.key === 'nav.invoices' && !showCompanies ? legacyPersonalInvoicesItem : item))
        .filter(item => (!item.needsCompany || showCompanies) && isItemVisible(item))
  return { tierTop: visibleTierTop, main: visibleMain, partner: visiblePartner, showCompanies }
}

// ───────────────────────── the grid ─────────────────────────
const FLAGS = ['billing', 'customers', 'invoices', 'invoiceHub', 'documentGenerator', 'pendingSignatures'] as const
const NAV_VISIBILITIES: Array<Record<string, boolean> | undefined> = [undefined]
for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
  const v: Record<string, boolean> = { services: true, taxDocuments: true, deadlines: true, documents: true }
  FLAGS.forEach((f, i) => { v[f] = !!(mask & (1 << i)) })
  NAV_VISIBILITIES.push(v)
}
const TIERS: Array<string | undefined> = [undefined, 'lead', 'formation', 'onboarding', 'active', 'not-a-tier']
const ROLES: Array<string | null | undefined> = [undefined, null, 'client', 'partner']
const ACCOUNT_TYPES: Array<string | null> = [null, 'One-Time', 'Annual']
const none: Record<string, boolean> = {}
const all: Record<string, boolean> = Object.fromEntries(TEAM_CAPABILITIES.map(c => [c, true]))
const TEAMMATE_CAPS: Array<Record<string, boolean>> = [none, all, ...TEAM_CAPABILITIES.map(c => ({ [c]: true }))]

interface GridContext {
  isTeammate: boolean
  caps: Record<string, boolean>
  navVisibility: Record<string, boolean> | undefined
  portalTier: string | undefined
  portalRole: string | null | undefined
  accountType: string | null
  canManageTeam: boolean
  hasWizardPending: boolean
  hasCompany: boolean
}

function forEachContext(visit: (c: GridContext) => void) {
  for (const isTeammate of [false, true]) {
    for (const caps of isTeammate ? TEAMMATE_CAPS : [none]) {
      for (const navVisibility of NAV_VISIBILITIES) {
        for (const portalTier of TIERS) {
          for (const portalRole of ROLES) {
            for (const accountType of ACCOUNT_TYPES) {
              for (const canManageTeam of [false, true]) {
                for (const hasWizardPending of [false, true]) {
                  for (const hasCompany of [false, true]) {
                    visit({ isTeammate, caps, navVisibility, portalTier, portalRole, accountType, canManageTeam, hasWizardPending, hasCompany })
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

const shape = (items: Array<{ key: string; href: string; hintKey?: string }>) => items.map(i => `${i.key}|${i.href}|${i.hintKey ?? ''}`)

describe('parity: the shared rule gives exactly the menu the old side menu gave', () => {
  it('matches for every kind of login (tier x role x account type x team member x flags x company)', () => {
    let checked = 0
    forEachContext(c => {
      const old = legacyMenu({
        navVisibility: c.navVisibility,
        portalTier: c.portalTier,
        accountType: c.accountType,
        portalRole: c.portalRole,
        hasWizardPending: c.hasWizardPending,
        canManageTeam: c.canManageTeam,
        isTeammate: c.isTeammate,
        teammateCapabilities: c.caps,
        accountsLength: c.hasCompany ? 1 : 0,
      })
      const ctx: NavRuleContext = {
        navVisibility: c.navVisibility as unknown as NavRuleContext['navVisibility'],
        portalTier: c.portalTier,
        accountType: c.accountType,
        portalRole: c.portalRole,
        hasWizardPending: c.hasWizardPending,
        canManageTeam: c.canManageTeam,
        isTeammate: c.isTeammate,
        teammateCapabilities: c.caps,
        hasCompany: c.hasCompany,
      }
      const mine = {
        tierTop: visibleTierTopItems(ctx),
        main: visibleMainItems(ctx),
        partner: visiblePartnerItems(ctx),
      }
      // Compare cheaply for every combination; only build the readable label (and use expect) when something differs.
      const same =
        shape(mine.main).join(',') === shape(old.main).join(',') &&
        shape(mine.tierTop).join(',') === shape(old.tierTop).join(',') &&
        shape(mine.partner).join(',') === shape(old.partner).join(',') &&
        showCompaniesSection(ctx) === old.showCompanies
      if (!same) {
        const label = JSON.stringify({ ...c, caps: Object.keys(c.caps) })
        expect(shape(mine.main), `main for ${label}`).toEqual(shape(old.main))
        expect(shape(mine.tierTop), `tierTop for ${label}`).toEqual(shape(old.tierTop))
        expect(shape(mine.partner), `partner for ${label}`).toEqual(shape(old.partner))
        expect(showCompaniesSection(ctx), `companies for ${label}`).toBe(old.showCompanies)
      }
      checked++
    })
    // 2 kinds of login x flags x tiers x roles x ...: a guard against the grid silently shrinking to nothing
    expect(checked).toBeGreaterThan(400_000)
  }, 60_000)

  it('the item lists themselves are the old lists (key, href and flags)', () => {
    const strip = (items: Array<LegacyItem | PortalNavItemDef>) => items.map(i => JSON.stringify(Object.fromEntries(Object.entries(i).sort())))
    expect(strip(MAIN_NAV_ITEMS)).toEqual(strip(legacyMainItems))
    expect(strip(TIER_TOP_NAV_ITEMS)).toEqual(strip(legacyTierTopItems))
    expect(strip(PARTNER_NAV_ITEMS)).toEqual(strip(legacyPartnerItems))
    expect(strip(BOTTOM_NAV_ITEMS)).toEqual(strip(legacyBottomItems))
    expect(strip([PERSONAL_INVOICES_NAV_ITEM])).toEqual(strip([legacyPersonalInvoicesItem]))
  })
})

// ───────────────────────── spot checks written fresh (not copied from the old code) ─────────────────────────
const active = (extra: Partial<NavRuleContext> = {}): NavRuleContext => ({
  portalTier: 'active',
  hasCompany: true,
  navVisibility: { billing: true, invoices: true, customers: true, invoiceHub: true, documentGenerator: true, pendingSignatures: true } as never,
  ...extra,
})
const keysOf = (ctx: NavRuleContext) => visibleMainItems(ctx).map(i => i.key)

describe('spot checks', () => {
  it('an active client with a company sees the whole list except Team (company admins only)', () => {
    expect(keysOf(active())).toEqual([
      'nav.overview', 'nav.chat', 'nav.referrals', 'nav.myClients', 'nav.invoices', 'nav.documents',
      'nav.generateDocuments', 'nav.signDocuments', 'nav.tdBilling', 'nav.bankApplications', 'nav.requestService', 'nav.myCompany',
    ])
    expect(keysOf(active({ canManageTeam: true }))).toContain('nav.team')
  })

  it('TD Billing shows only once TD has billed the client', () => {
    expect(keysOf(active())).toContain('nav.tdBilling')
    expect(keysOf(active({ navVisibility: { billing: false, invoices: true } as never }))).not.toContain('nav.tdBilling')
  })

  it('Bank Applications is for the active tier only', () => {
    expect(keysOf(active({ portalTier: 'formation' }))).not.toContain('nav.bankApplications')
    expect(keysOf(active())).toContain('nav.bankApplications')
  })

  it('a lead with no company sees Overview, Chat, the personal invoices entry and Request a Service (Referrals is not a lead feature)', () => {
    const items = visibleMainItems({ portalTier: 'lead', hasCompany: false })
    expect(items.map(i => i.key)).toEqual(['nav.overview', 'nav.chat', 'nav.invoices', 'nav.requestService'])
    expect(items.find(i => i.key === 'nav.invoices')?.hintKey).toBe('invoicesPersonal')
  })

  it('a partner sees only the partner list', () => {
    const ctx: NavRuleContext = { portalRole: 'partner', portalTier: 'active', hasCompany: true }
    expect(visibleMainItems(ctx)).toEqual([])
    expect(visiblePartnerItems(ctx).map(i => i.key)).toEqual(['nav.partnerClients', 'nav.partnerReferrals', 'nav.partnerNewRequest', 'nav.partnerInvoices', 'nav.chat'])
  })

  it('a team member gets Overview and the entries their capabilities allow, never Team, Sign, Referrals or Request a Service', () => {
    const ctx = active({ isTeammate: true, teammateCapabilities: { chat: true, documents: true } })
    const keys = keysOf(ctx)
    expect(keys).toEqual(expect.arrayContaining(['nav.overview', 'nav.chat', 'nav.documents']))
    for (const k of ['nav.team', 'nav.signDocuments', 'nav.referrals', 'nav.requestService', 'nav.invoices', 'nav.tdBilling']) {
      expect(keys).not.toContain(k)
    }
  })

  it('isNavItemVisible answers for one entry (what the app will ask)', () => {
    const chat = MAIN_NAV_ITEMS.find(i => i.key === 'nav.chat')!
    expect(isNavItemVisible(chat, active())).toBe(true)
    expect(isNavItemVisible(chat, active({ isTeammate: true, teammateCapabilities: {} }))).toBe(false)
  })
})

describe('the side menu uses the shared rule', () => {
  const side = readFileSync('components/portal/portal-sidebar.tsx', 'utf8')

  it('no longer keeps its own copy of the lists or the rule', () => {
    expect(side).not.toContain('const isItemVisible')
    expect(side).not.toContain('const mainItems')
    expect(side).toContain("from '@/lib/portal/nav-rules'")
    expect(side).toContain('visibleMainItems(navCtx)')
  })

  it('has an icon for every entry of every list (a missing one would crash the menu)', () => {
    const iconBlock = side.slice(side.indexOf('const NAV_ICONS'), side.indexOf('const withIcon'))
    const every = [...MAIN_NAV_ITEMS, ...TIER_TOP_NAV_ITEMS, ...PARTNER_NAV_ITEMS, ...BOTTOM_NAV_ITEMS, PERSONAL_INVOICES_NAV_ITEM]
    for (const item of every) expect(iconBlock, item.key).toContain(`'${item.key}':`)
  })
})
