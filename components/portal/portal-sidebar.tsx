'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  FileText,
  Receipt,
  Building2,
  MessageCircle,
  BookOpen,
  Users,
  LogOut,
  Menu,
  X,
  User,
  PenSquare,
  Share2,
  Briefcase,
  FolderOpen,
  CreditCard,
  PenLine,
  FilePen,
  PlusCircle,
  Mail,
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'
import { CompanySwitcher } from './company-switcher'
import { GlobalSearch } from '@/components/shared/global-search'
import type { PortalAccount } from '@/lib/types'
import type { PortalNavVisibility, InProgressFormation } from '@/lib/portal/queries'
import { isTierFeatureVisible, isPartnerPortal } from '@/lib/portal/tier-config'

interface PortalSidebarProps {
  user: { email?: string; user_metadata?: { full_name?: string } }
  accounts: PortalAccount[]
  selectedAccountId: string
  activeServices?: string[]
  navVisibility?: PortalNavVisibility
  portalTier?: string
  unreadChatCount?: number
  hasWizardPending?: boolean
  accountType?: string | null
  contactId?: string
  portalRole?: string | null
  /** Companies being formed that have no account yet — selectable in the switcher. */
  inProgress?: InProgressFormation[]
  /** Set when an in-progress formation is the current selection. */
  selectedFormationId?: string
  /** True when the logged-in user is the account admin for the selected company (can manage the Team tab). */
  canManageTeam?: boolean
}

// Nav items organized into collapsible groups
interface NavItem {
  key: string
  href: string
  icon: typeof LayoutDashboard
  visibilityKey?: keyof PortalNavVisibility // if set, item only shows when this flag is true
  tierOnly?: string[] // if set, only show for these tiers
  wizardDynamic?: boolean // if true, also show when hasWizardPending is true
  partnerOnly?: boolean // if true, only show for partner portal
  teamAdminOnly?: boolean // if true, only show when canManageTeam is true (Portal Team Access)
}

// (NavGroup interface removed in PR 2 Step 7 — sections are now hard-coded
// rather than data-driven, since there are exactly two: Personal + Companies.)

// PR 2 Step 7 (2026-05-05) — sidebar restructure per Antonio's architectural
// model: contact is the home, personal stuff at top, companies nested below.
// No "My Profile vs My Company" toggle. Multi-LLC clients still get a switcher
// inside the Companies section.

// Personal section — items scoped to the contact (the person).
//
// Invoices placement (Antonio 2026-05-05): "Lorenzo is just an individual
// that bought the formation to create a company. Lorenzo, as an individual,
// will see the invoice for 2,500 that he paid to buy the formation service.
// After the company is created, he will use the invoice system."
//
// So /portal/invoices link follows context:
//   - No company yet → "Invoices" appears in Personal (Lorenzo sees his
//     personal formation receipt). Inserted at render time, not in this
//     array, because it depends on accounts.length.
//   - Company exists → "Invoices" appears under Company (the full
//     Sales/Expenses/Vendors invoicing system).
const personalItems: NavItem[] = [
  { key: 'nav.chat', href: '/portal/chat', icon: MessageCircle },
  { key: 'nav.requestService', href: '/portal/services/request', icon: PlusCircle },
  // ITIN Documents — conditional on the contact having an active ITIN SD at
  // "Client Signing" stage (Phase C, 2026-05-11). The page shows the generated
  // W-7 + 1040-NR PDFs and the mailing instructions for the client to mail to
  // Antonio's CAA office.
  { key: 'nav.itinDocuments', href: '/portal/itin-documents', icon: Mail, visibilityKey: 'itinAtClientSigning' },
  { key: 'nav.referrals', href: '/portal/referrals', icon: Share2 },
  { key: 'nav.profile', href: '/portal/profile', icon: User },
]

// Invoices link for personal/individual context (no company yet). Inserted
// into the Personal section's render output when showCompaniesSection is
// false. Same href as the Company-section Invoices, but the page itself
// already branches: with no account, /portal/invoices renders only the
// Expenses tab with contact-scoped TD invoices (PR 2 Step 4).
const personalInvoicesItem: NavItem = {
  key: 'nav.invoices', href: '/portal/invoices', icon: Receipt,
}

// Tier-specific items shown above the Personal section (CTAs the client hits
// before they have a company). Lead → Offer; Onboarding → Wizard.
const tierTopItems: NavItem[] = [
  { key: 'nav.offer', href: '/portal/offer', icon: FileText, tierOnly: ['lead'] },
  { key: 'nav.wizard', href: '/portal/wizard', icon: PenSquare, tierOnly: ['onboarding'], wizardDynamic: true },
]

// Items nested under the Companies section header. Active-tier only — these
// pages are account-scoped (read by selectedAccountId).
//
// `nav.businessSettings` was removed in PR 2 Step 7 — it pointed to
// /portal/profile which is the SAME route as the new "Profile" item under
// Personal. Two sidebar links to the same URL was confusing. The Profile
// page already renders both personal info AND business settings (logo,
// bank accounts, payment links) — one link covers both.
const companyItems: NavItem[] = [
  { key: 'nav.overview', href: '/portal', icon: LayoutDashboard },
  { key: 'nav.myCompany', href: '/portal/company', icon: Briefcase },
  { key: 'nav.team', href: '/portal/team', icon: Users, teamAdminOnly: true },
  { key: 'nav.documents', href: '/portal/documents', icon: FolderOpen },
  { key: 'nav.signDocuments', href: '/portal/sign', icon: PenLine, visibilityKey: 'pendingSignatures' },
  { key: 'nav.generateDocuments', href: '/portal/documents/generate', icon: FilePen, visibilityKey: 'documentGenerator' },
  { key: 'nav.myClients', href: '/portal/customers', icon: Users, visibilityKey: 'customers' },
  // Invoices belongs under Company per Antonio 2026-05-05 — it's the
  // company's invoicing system (sales invoices to the client's customers
  // + TD's expense invoices to the company). Hidden for no-company
  // clients because the whole Companies section is hidden then.
  { key: 'nav.invoices', href: '/portal/invoices', icon: Receipt, visibilityKey: 'invoices' },
  { key: 'nav.tdBilling', href: '/portal/billing', icon: CreditCard, visibilityKey: 'billing' },
]

// Partner-portal items shown only when isPartnerPortal(portalRole). Flat list,
// not under any section header.
const partnerItems: NavItem[] = [
  { key: 'nav.partnerClients', href: '/portal/partner/clients', icon: Building2, partnerOnly: true },
  { key: 'nav.partnerNewRequest', href: '/portal/partner/new-request', icon: PlusCircle, partnerOnly: true },
  { key: 'nav.partnerInvoices', href: '/portal/partner/invoices', icon: Receipt, partnerOnly: true },
  { key: 'nav.chat', href: '/portal/chat', icon: MessageCircle, partnerOnly: true },
]

const bottomItems: NavItem[] = [
  { key: 'nav.guide', href: '/portal/guide', icon: BookOpen },
]

// i18n fallback for section labels (used when no t() key exists yet).
const SECTION_LABELS: Record<string, Record<string, string>> = {
  'nav.section.personal': { en: 'Personal', it: 'Personale' },
  'nav.section.companies': { en: 'Companies', it: 'Aziende' },
  'nav.section.company': { en: 'Company', it: 'Azienda' },
}


export function PortalSidebar({ user, accounts, selectedAccountId, activeServices: _activeServices, navVisibility, portalTier, unreadChatCount = 0, accountType, contactId, portalRole, hasWizardPending, inProgress = [], selectedFormationId, canManageTeam = false }: PortalSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [liveUnreadCount, setLiveUnreadCount] = useState(unreadChatCount)
  const pathnameRef = useRef(pathname)
  const { t, locale } = useLocale()

  // Keep pathname ref in sync for use inside realtime callback
  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  // Reset badge when user opens the chat page
  useEffect(() => {
    if (pathname === '/portal/chat') {
      setLiveUnreadCount(0)
    }
  }, [pathname])

  // Sync PWA app icon badge with unread count
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return
    if (liveUnreadCount > 0) {
      navigator.setAppBadge(liveUnreadCount).catch(() => {})
    } else {
      navigator.clearAppBadge().catch(() => {})
    }
  }, [liveUnreadCount])

  // Subscribe to new admin messages for real-time badge updates
  useEffect(() => {
    // PR 2 Step 6 (chat unification): always filter by contact_id, regardless
    // of whether an account is selected. The pre-PR 2 logic filtered by
    // account_id when one was set — that meant admin messages tagged
    // "Personal" (account_id=null) didn't increment the badge for active-tier
    // clients. Threading is per-contact now, so the unread count is too.
    if (!contactId) return

    const supabase = createClient()
    const channel = supabase
      .channel(`sidebar-unread-${contactId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
          filter: `contact_id=eq.${contactId}`,
        },
        (payload) => {
          const newMsg = payload.new as { sender_type: string }
          if (newMsg.sender_type === 'admin' && pathnameRef.current !== '/portal/chat') {
            setLiveUnreadCount(prev => prev + 1)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [contactId])

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  const isActive = (href: string) => {
    // Strip query params for path matching
    const hrefPath = href.split('?')[0]
    if (hrefPath === '/portal') return pathname === '/portal'
    return pathname.startsWith(hrefPath)
  }

  const fullName = user.user_metadata?.full_name?.trim() ?? ''
  const displayName = fullName || user.email?.split('@')[0] || 'User'

  // Locale-aware section labels — used by the Personal / Companies headers.
  const personalLabel = SECTION_LABELS['nav.section.personal']?.[locale] ?? SECTION_LABELS['nav.section.personal']?.en ?? 'Personal'
  const totalEntities = accounts.length + inProgress.length
  const isMultiEntity = totalEntities > 1
  const companiesLabel = (totalEntities > 1
    ? SECTION_LABELS['nav.section.companies']
    : SECTION_LABELS['nav.section.company'])?.[locale] ?? 'Companies'
  const loggedInAsLabel = locale === 'it' ? 'Accesso come' : 'Logged in as'

  const isPartner = isPartnerPortal(portalRole)

  // Standard visibility filter — same logic the previous structure used,
  // just factored so it can run against any item array.
  const isItemVisible = (item: NavItem): boolean => {
    if (item.teamAdminOnly) return canManageTeam
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

    if (item.key === 'nav.referrals') {
      return isTierFeatureVisible(portalTier || null, 'referralManagement', accountType, portalRole)
    }

    if (item.visibilityKey) {
      if (!isTierFeatureVisible(portalTier || null, item.visibilityKey, accountType, portalRole)) return false
      return navVisibility?.[item.visibilityKey] ?? false
    }

    if (!item.tierOnly) return true
    if (item.wizardDynamic && hasWizardPending) return true
    return item.tierOnly.includes(portalTier || 'lead')
  }

  const visibleTierTop = tierTopItems.filter(isItemVisible)
  const visiblePartner = partnerItems.filter(isItemVisible)
  // Company section visible only for non-partners with at least one account.
  // Active-tier with no account (rare edge case) hides the section too.
  const showCompaniesSection = !isPartner && accounts.length > 0
  const visibleCompanyItems = showCompaniesSection ? companyItems.filter(isItemVisible) : []

  // Personal Invoices link is added when there's no company section
  // (Antonio's model: Lorenzo as individual sees his personal formation
  // invoice in Personal; after the company exists, the invoice system
  // moves under Company).
  const visiblePersonal = (() => {
    const base = personalItems.filter(isItemVisible)
    if (!isPartner && !showCompaniesSection) {
      // Insert Invoices after Chat for visual grouping.
      const chatIdx = base.findIndex(i => i.key === 'nav.chat')
      const insertAt = chatIdx >= 0 ? chatIdx + 1 : 0
      const next = base.slice()
      next.splice(insertAt, 0, personalInvoicesItem)
      return next
    }
    return base
  })()

  // For single-LLC clients, show the company name as the section header.
  // For multi-LLC clients, the CompanySwitcher provides the selector.
  const selectedCompanyName = accounts.find(a => a.id === selectedAccountId)?.company_name ?? null

  const renderNavItem = (item: NavItem) => {
    const badge = item.href === '/portal/chat' && liveUnreadCount > 0 ? liveUnreadCount : 0

    // Context-aware label for the wizard nav item.
    // The tab serves two purposes depending on the client's stage:
    //   - formation / onboarding tier → company data collection ("Complete Setup")
    //   - active tier with a Banking Fintech SD → bank account application ("Bank Applications")
    // Italian had a single static label ("Completa Registrazione") that made sense
    // for onboarding but was invisible to banking clients searching for "bank applications".
    let navLabel = t(item.key)
    if (item.key === 'nav.wizard') {
      const isBankingContext = portalTier !== 'formation' && portalTier !== 'onboarding'
      if (isBankingContext) {
        navLabel = locale === 'it' ? 'Apertura Conto Bancario' : 'Bank Applications'
      } else {
        navLabel = locale === 'it' ? 'Completa Registrazione' : 'Complete Setup'
      }
    }

    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileOpen(false)}
        aria-current={isActive(item.href) ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isActive(item.href)
            ? 'bg-blue-50 text-blue-700'
            : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        <span className="flex-1">{navLabel}</span>
        {badge > 0 && (
          <span className="min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </Link>
    )
  }

  return (
    <>
      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-40 h-14 bg-white border-b flex items-center px-4 lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-2 rounded-md hover:bg-zinc-100"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="ml-3 flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-600 text-white text-xs font-bold flex items-center justify-center">TD</div>
          <span className="font-semibold text-sm">{t('nav.portal')}</span>
        </div>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-white border-r flex flex-col transition-transform lg:translate-x-0 lg:static lg:z-auto',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-5 border-b">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 text-white text-sm font-bold flex items-center justify-center">TD</div>
            <span className="font-semibold text-zinc-900">{t('nav.portal')}</span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 rounded hover:bg-zinc-100"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Contact name — the person is the home (PR 2 Step 7).
            Hidden for partners (they're not "logged in as a contact" in the
            same sense — they manage referrals). */}
        {!isPartner && (
          <div className="px-5 py-3 border-b">
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-0.5">{loggedInAsLabel}</div>
            <div className="font-semibold text-zinc-900 truncate text-sm">{displayName}</div>
          </div>
        )}

        {/* Search */}
        <div className="px-3 py-2 border-b">
          <GlobalSearch
            searchEndpoint="/api/portal/search"
            mode="portal"
            accountId={selectedAccountId}
            placeholder={t('nav.search') !== 'nav.search' ? t('nav.search') : 'Search...'}
          />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {/* Tier-specific top items (Offer for leads, Wizard for onboarding) — */}
          {/* sit ABOVE the Personal section because they're action CTAs for clients */}
          {/* who don't yet have a company. */}
          {visibleTierTop.map(renderNavItem)}

          {/* Personal section — always visible (chat / invoices / referrals / profile). */}
          {/* Hidden for partners since their flow is different. */}
          {!isPartner && visiblePersonal.length > 0 && (
            <div className={visibleTierTop.length > 0 ? 'pt-3' : ''}>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                {personalLabel}
              </div>
              <div className="space-y-0.5">
                {visiblePersonal.map(renderNavItem)}
              </div>
            </div>
          )}

          {/* Partner-only items (referral portal flow). */}
          {isPartner && visiblePartner.length > 0 && (
            <div className="pt-3 space-y-0.5">
              {visiblePartner.map(renderNavItem)}
            </div>
          )}

          {/* Companies section — nested under Personal per Antonio's model. */}
          {/* For single-LLC clients, the company name is the section header. */}
          {/* For multi-LLC clients, the CompanySwitcher dropdown picks which company. */}
          {showCompaniesSection && (isMultiEntity || visibleCompanyItems.length > 0) && (
            <div className="pt-4">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                {companiesLabel}
              </div>
              {isMultiEntity ? (
                <div className="px-0 py-1">
                  <CompanySwitcher
                    accounts={accounts}
                    selectedAccountId={selectedAccountId}
                    inProgress={inProgress}
                    selectedFormationId={selectedFormationId}
                    userName={fullName || user.email?.split('@')[0]}
                  />
                </div>
              ) : selectedCompanyName ? (
                <div className="px-3 py-1.5 flex items-center gap-2 text-sm text-zinc-900 font-medium">
                  <Briefcase className="h-4 w-4 text-blue-600 shrink-0" />
                  <span className="truncate">{selectedCompanyName}</span>
                </div>
              ) : null}
              {visibleCompanyItems.length > 0 && (
                <div className="space-y-0.5 mt-1">
                  {visibleCompanyItems.map(renderNavItem)}
                </div>
              )}
            </div>
          )}

          {/* Bottom items (Guide) */}
          <div className="pt-4">
            {bottomItems.map(renderNavItem)}
          </div>
        </nav>

        {/* Footer — Profile link removed (now in Personal section). Sign Out only. */}
        <div className="px-3 py-4 border-t">
          {/* Identity row — small, repeats the contact name as a visual reminder. */}
          <div className="flex items-center gap-3 px-3 py-2 text-sm text-zinc-500">
            <User className="h-4 w-4" />
            <span className="flex-1 truncate">{displayName}</span>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-zinc-600 hover:bg-zinc-50 hover:text-red-600 transition-colors w-full"
          >
            <LogOut className="h-4 w-4" />
            {t('nav.signOut')}
          </button>
        </div>
      </aside>
    </>
  )
}
