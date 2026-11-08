/**
 * The client portal's menu: WHICH entries exist, in WHAT order, and WHO sees each one. Pure, no React, no icons.
 *
 * Before 2026-11-08 these lists and the show/hide rule lived inside `components/portal/portal-sidebar.tsx`. The
 * iPhone client app needs the very same answers from the server (what can this person open, and what is in their
 * bottom bar), so the lists and the rule moved here and BOTH the website's side menu and the app's server answer read
 * them. Moving them changed no behaviour: `tests/unit/portal-nav-rules.test.ts` runs the old rule (kept verbatim in
 * the test) and this one over every kind of login and requires identical lists.
 *
 * Icons stay in the sidebar (a React concern), keyed by the item's `key`.
 */

import type { PortalNavVisibility } from '@/lib/portal/queries'
import { isTierFeatureVisible, isPartnerPortal } from '@/lib/portal/tier-config'
import { hubAccess } from '@/lib/portal/invoice-hub'
import { hasCapability, teammateNavCapability, type TeamCapability } from '@/lib/portal/team/capabilities'

export interface PortalNavItemDef {
  key: string
  href: string
  /** If set, the item only shows when this flag is true (and the tier allows the feature). */
  visibilityKey?: keyof PortalNavVisibility
  /** If set, only show for these tiers. */
  tierOnly?: string[]
  /** If true, also show when a wizard is pending. */
  wizardDynamic?: boolean
  /** If true, only show for the partner portal. */
  partnerOnly?: boolean
  /** If true, only show when the person manages the company's team (Portal Team Access). */
  teamAdminOnly?: boolean
  /** If set, the info-popover text uses nav.hint.<hintKey> instead of deriving it from the key. */
  hintKey?: string
  /** If true, only show once the client has at least one company (account). */
  needsCompany?: boolean
}

// Antonio 2026-11-05: the menu is ONE flat list. The order below is his. Each item keeps its own show/hide rule (tier,
// invoice hub, teammate capabilities); `needsCompany` items appear only once the client has a company. La Mia Azienda
// sits at the bottom of the list: it is the only menu route to the Services and Deadlines pages now that those cards
// left Panoramica.
//
// Invoices placement (Antonio 2026-05-05): "Lorenzo is just an individual that bought the formation to create a
// company. Lorenzo, as an individual, will see the invoice for 2,500 that he paid to buy the formation service. After
// the company is created, he will use the invoice system." So with NO company yet the same slot holds the personal
// variant (PERSONAL_INVOICES_NAV_ITEM below); with a company it is the full invoicing system.
export const MAIN_NAV_ITEMS: PortalNavItemDef[] = [
  { key: 'nav.overview', href: '/portal' },
  { key: 'nav.chat', href: '/portal/chat' },
  { key: 'nav.referrals', href: '/portal/referrals' },
  // Customers page for companies WITHOUT the new invoices screen (the hub's Customers tab replaces it).
  { key: 'nav.myClients', href: '/portal/customers', visibilityKey: 'customers', needsCompany: true },
  // 'Clienti e Fatture' once the hub is on for the company, plain 'Fatture' otherwise (label chosen in the sidebar).
  { key: 'nav.invoices', href: '/portal/invoices', visibilityKey: 'invoices', needsCompany: true },
  { key: 'nav.documents', href: '/portal/documents', needsCompany: true },
  { key: 'nav.team', href: '/portal/team', teamAdminOnly: true, needsCompany: true },
  { key: 'nav.generateDocuments', href: '/portal/documents/generate', visibilityKey: 'documentGenerator', needsCompany: true },
  // Sign Documents is deliberately NOT gated on data presence — see the nav.signDocuments branch in isNavItemVisible().
  { key: 'nav.signDocuments', href: '/portal/sign', needsCompany: true },
  { key: 'nav.tdBilling', href: '/portal/billing', visibilityKey: 'billing', needsCompany: true },
  // Bank Applications — self-service guidance to open a business bank account (replaces the old Banking Fintech
  // wizard/SD). Active company clients only.
  { key: 'nav.bankApplications', href: '/portal/banks', needsCompany: true },
  { key: 'nav.requestService', href: '/portal/services/request' },
  { key: 'nav.myCompany', href: '/portal/company', needsCompany: true },
]

// Invoices link for personal/individual context (no company yet). Takes the place of the 'nav.invoices' entry in
// MAIN_NAV_ITEMS when the client has no company. Same href as the company Invoices, but the page itself already
// branches: with no account, /portal/invoices renders only the Expenses tab with contact-scoped TD invoices.
export const PERSONAL_INVOICES_NAV_ITEM: PortalNavItemDef = {
  key: 'nav.invoices',
  href: '/portal/invoices',
  // Distinct hint text: this branch renders only the Expenses tab for a no-company client, not the company's
  // sales-invoicing system the shared 'nav.invoices' hint describes.
  hintKey: 'invoicesPersonal',
}

// Tier-specific items shown above the list (calls to action the client hits before they have a company).
// Lead → Offer; Onboarding → Wizard.
export const TIER_TOP_NAV_ITEMS: PortalNavItemDef[] = [
  { key: 'nav.offer', href: '/portal/offer', tierOnly: ['lead'] },
  { key: 'nav.wizard', href: '/portal/wizard', tierOnly: ['onboarding'], wizardDynamic: true },
]

// Partner-portal items shown only when isPartnerPortal(portalRole). Flat list, not under any section header.
export const PARTNER_NAV_ITEMS: PortalNavItemDef[] = [
  { key: 'nav.partnerClients', href: '/portal/partner/clients', partnerOnly: true },
  { key: 'nav.partnerReferrals', href: '/portal/partner/referrals', partnerOnly: true },
  { key: 'nav.partnerNewRequest', href: '/portal/partner/new-request', partnerOnly: true },
  { key: 'nav.partnerInvoices', href: '/portal/partner/invoices', partnerOnly: true },
  { key: 'nav.chat', href: '/portal/chat', partnerOnly: true },
]

export const BOTTOM_NAV_ITEMS: PortalNavItemDef[] = [
  { key: 'nav.guide', href: '/portal/guide' },
]

/** Everything the show/hide rule looks at. */
export interface NavRuleContext {
  navVisibility?: PortalNavVisibility
  portalTier?: string
  accountType?: string | null
  portalRole?: string | null
  hasWizardPending?: boolean
  /** The logged-in person manages the selected company's team (Portal Team Access). */
  canManageTeam?: boolean
  /** The logged-in person is a teammate (Portal Team Access): the menu follows granted capabilities only. */
  isTeammate?: boolean
  /** The teammate's granted capability flags (only meaningful when isTeammate). */
  teammateCapabilities?: Record<string, boolean>
  /** The client has at least one company (account). */
  hasCompany: boolean
}

/** Same rule as the Invoices page (lib/portal/invoice-hub.ts hubAccess): a team member gets the hub only through the capabilities the owner granted. */
export function navHubRule(ctx: Pick<NavRuleContext, 'navVisibility' | 'isTeammate' | 'teammateCapabilities'>) {
  const isTeammate = ctx.isTeammate ?? false
  return hubAccess({
    hubOn: !!ctx.navVisibility?.invoiceHub,
    hasAccount: true,
    isClient: !isTeammate,
    teammateCapabilities: isTeammate ? ((ctx.teammateCapabilities ?? {}) as Partial<Record<TeamCapability, boolean>>) : null,
  })
}

/** Does this person see this menu entry? The one rule behind the website's side menu and the app. */
export function isNavItemVisible(item: PortalNavItemDef, ctx: NavRuleContext): boolean {
  const canManageTeam = ctx.canManageTeam ?? false
  const isTeammate = ctx.isTeammate ?? false
  const teammateCapabilities = (ctx.teammateCapabilities ?? {}) as Partial<Record<TeamCapability, boolean>>
  const { portalTier, accountType, portalRole, navVisibility, hasWizardPending } = ctx
  const isPartner = isPartnerPortal(portalRole)

  if (item.teamAdminOnly) return canManageTeam
  // Teammate (Portal Team Access): nav is governed solely by granted capabilities.
  if (isTeammate) {
    const cap = teammateNavCapability(item.key)
    if (cap === null) return false
    if (cap === 'always') return true
    // The hub's Customers tab replaces the separate "My clients" page for a team member who can open the hub.
    const hubRule = navHubRule(ctx)
    if (item.key === 'nav.myClients' && hubRule.customers && hubRule.setup) return false
    return hasCapability(teammateCapabilities, cap)
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

  // Bank Applications — only once the company is fully formed (EIN received → active tier). A formation-tier client
  // (EIN pending) can't open an account yet, so the entry stays hidden until then.
  if (item.key === 'nav.bankApplications') {
    return (portalTier || 'lead') === 'active'
  }

  if (item.key === 'nav.referrals') {
    return isTierFeatureVisible(portalTier || null, 'referralManagement', accountType, portalRole)
  }

  // Sign Documents — tier-gated ONLY, never gated on "does this client have a pending document right now".
  // Antonio, 2026-07-22: "this tab must be there even though there is nothing. It doesn't make sense to have a tab that
  // disappears if there is no document, or if there is a document." A stable, always-present entry makes support
  // instructions true; the page owns the empty state.
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

/** Company items need at least one account; a partner never sees them. */
export function showCompaniesSection(ctx: Pick<NavRuleContext, 'portalRole' | 'hasCompany'>): boolean {
  return !isPartnerPortal(ctx.portalRole) && ctx.hasCompany
}

export function visibleTierTopItems(ctx: NavRuleContext): PortalNavItemDef[] {
  return TIER_TOP_NAV_ITEMS.filter(item => isNavItemVisible(item, ctx))
}

export function visiblePartnerItems(ctx: NavRuleContext): PortalNavItemDef[] {
  return PARTNER_NAV_ITEMS.filter(item => isNavItemVisible(item, ctx))
}

/** The flat menu. With no company yet, the invoices slot holds the personal-receipts variant. Empty for a partner. */
export function visibleMainItems(ctx: NavRuleContext): PortalNavItemDef[] {
  if (isPartnerPortal(ctx.portalRole)) return []
  const companies = showCompaniesSection(ctx)
  return MAIN_NAV_ITEMS
    .map(item => (item.key === 'nav.invoices' && !companies ? PERSONAL_INVOICES_NAV_ITEM : item))
    .filter(item => (!item.needsCompany || companies) && isNavItemVisible(item, ctx))
}
