'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  FileText,
  Receipt,
  MessageCircle,
  Activity,
  BookOpen,
  Upload,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  User,
  CalendarDays,
  CreditCard,
  ChevronDown,
  PenSquare,
  PenLine,
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'
import { CompanySwitcher } from './company-switcher'
import { GlobalSearch } from '@/components/shared/global-search'
import type { PortalAccount } from '@/lib/types'
import type { PortalNavVisibility } from '@/lib/portal/queries'
import { isTierFeatureVisible } from '@/lib/portal/tier-config'

interface PortalSidebarProps {
  user: { email?: string; user_metadata?: { full_name?: string } }
  accounts: PortalAccount[]
  selectedAccountId: string
  activeServices?: string[]
  navVisibility?: PortalNavVisibility
  portalTier?: string
  unreadChatCount?: number
  accountType?: string | null
  contactId?: string
}

// Nav items organized into collapsible groups
interface NavItem {
  key: string
  href: string
  icon: typeof LayoutDashboard
  visibilityKey?: keyof PortalNavVisibility // if set, item only shows when this flag is true
  tierOnly?: string[] // if set, only show for these tiers
}

interface NavGroup {
  key: string // i18n key for group label
  items: NavItem[]
  defaultOpen?: boolean
}

// Flat items (always visible, no group)
const topItems: NavItem[] = [
  { key: 'nav.dashboard', href: '/portal', icon: LayoutDashboard },
  { key: 'nav.offer', href: '/portal/offer', icon: FileText, tierOnly: ['lead'] },
  { key: 'nav.wizard', href: '/portal/wizard', icon: PenSquare, tierOnly: ['onboarding'] },
  { key: 'nav.chat', href: '/portal/chat', icon: MessageCircle },
]

// Grouped items — each item can have a visibilityKey
const navGroups: NavGroup[] = [
  {
    key: 'nav.group.business',
    items: [
      { key: 'nav.documents', href: '/portal/documents', icon: FileText, visibilityKey: 'documents' },
      { key: 'nav.services', href: '/portal/services', icon: Activity, visibilityKey: 'services' },
      { key: 'nav.signDocuments', href: '/portal/sign', icon: PenLine, visibilityKey: 'pendingSignatures' },
      { key: 'nav.deadlines', href: '/portal/deadlines', icon: CalendarDays, visibilityKey: 'deadlines' },
      { key: 'nav.taxDocuments', href: '/portal/tax-documents', icon: Upload, visibilityKey: 'taxDocuments' },
    ],
    defaultOpen: true,
  },
  {
    key: 'nav.group.finance',
    items: [
      { key: 'nav.billing', href: '/portal/billing', icon: CreditCard, visibilityKey: 'billing' },
      { key: 'nav.invoices', href: '/portal/invoices', icon: Receipt, visibilityKey: 'invoices' },
      { key: 'nav.customers', href: '/portal/customers', icon: Users, visibilityKey: 'customers' },
    ],
    defaultOpen: true,
  },
]

const bottomItems: NavItem[] = [
  { key: 'nav.settings', href: '/portal/settings', icon: Settings },
  { key: 'nav.guide', href: '/portal/guide', icon: BookOpen },
]

// i18n fallback for group labels
const GROUP_LABELS: Record<string, Record<string, string>> = {
  'nav.group.business': { en: 'Business', it: 'Azienda' },
  'nav.group.finance': { en: 'Finance', it: 'Finanza' },
}

export function PortalSidebar({ user, accounts, selectedAccountId, activeServices: _activeServices, navVisibility, portalTier, unreadChatCount = 0, accountType, contactId }: PortalSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
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
    const filterColumn = selectedAccountId ? 'account_id' : (contactId ? 'contact_id' : null)
    const filterValue = selectedAccountId || contactId
    if (!filterColumn || !filterValue) return

    const supabase = createClient()
    const channel = supabase
      .channel(`sidebar-unread-${filterValue}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'portal_messages',
          filter: `${filterColumn}=eq.${filterValue}`,
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
  }, [selectedAccountId, contactId])

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  const isActive = (href: string) =>
    href === '/portal' ? pathname === '/portal' : pathname.startsWith(href)

  const displayName = user.email?.split('@')[0] ?? 'User'

  const renderNavItem = (item: NavItem) => {
    const badge = item.href === '/portal/chat' && liveUnreadCount > 0 ? liveUnreadCount : 0
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
        <span className="flex-1">{t(item.key)}</span>
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

        {/* Company Switcher */}
        {(accounts.length > 0 || user.email) && (
          <div className="px-3 py-3 border-b">
            <CompanySwitcher
              accounts={accounts}
              selectedAccountId={selectedAccountId}
              userName={user.user_metadata?.full_name || user.email?.split('@')[0]}
            />
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
          {/* Top items (filtered by tier) */}
          {topItems.filter(item => {
            if (!item.tierOnly) return true
            return item.tierOnly.includes(portalTier || 'lead')
          }).map(renderNavItem)}

          {/* Collapsible groups */}
          {navGroups.map(group => {
            // Filter items by visibility flags
            const visibleItems = group.items.filter(item => {
              // Check tier visibility first
              if (item.visibilityKey && !isTierFeatureVisible(portalTier || null, item.visibilityKey, accountType)) return false
              // Then check data-driven visibility
              if (!item.visibilityKey || !navVisibility) return true
              return navVisibility[item.visibilityKey]
            })

            // Skip entire group if no visible items
            if (visibleItems.length === 0) return null

            const isCollapsed = collapsedGroups.has(group.key)
            const groupLabel = GROUP_LABELS[group.key]?.[locale] ?? GROUP_LABELS[group.key]?.en ?? group.key
            const hasActiveItem = visibleItems.some(item => isActive(item.href))

            return (
              <div key={group.key} className="pt-3">
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center justify-between w-full px-3 py-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider hover:text-zinc-600 transition-colors"
                >
                  <span>{groupLabel}</span>
                  <ChevronDown className={cn('h-3 w-3 transition-transform', isCollapsed && '-rotate-90')} />
                </button>
                {(!isCollapsed || hasActiveItem) && (
                  <div className="mt-1 space-y-0.5">
                    {visibleItems.map(item => {
                      // If collapsed, only show the active item
                      if (isCollapsed && !isActive(item.href)) return null
                      return renderNavItem(item)
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* Bottom items */}
          <div className="pt-3">
            {bottomItems.map(renderNavItem)}
          </div>
        </nav>

        {/* Footer */}
        <div className="px-3 py-4 border-t">
          <Link
            href="/portal/profile"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 transition-colors"
          >
            <User className="h-4 w-4" />
            <span className="flex-1 truncate">{displayName}</span>
          </Link>
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
