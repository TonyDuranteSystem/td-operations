'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  FileText,
  Receipt,
  MessageCircle,
  Cog as CogIcon,
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
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/portal/use-locale'
import { CompanySwitcher } from './company-switcher'
import type { PortalAccount } from '@/lib/types'

interface PortalSidebarProps {
  user: { email?: string }
  accounts: PortalAccount[]
  selectedAccountId: string
}

const navItems = [
  { key: 'nav.dashboard', href: '/portal', icon: LayoutDashboard },
  { key: 'nav.documents', href: '/portal/documents', icon: FileText },
  { key: 'nav.invoices', href: '/portal/invoices', icon: Receipt },
  { key: 'nav.customers', href: '/portal/customers', icon: Users },
  { key: 'nav.taxDocuments', href: '/portal/tax-documents', icon: Upload },
  { key: 'nav.services', href: '/portal/services', icon: Activity },
  { key: 'nav.deadlines', href: '/portal/deadlines', icon: CalendarDays },
  { key: 'nav.chat', href: '/portal/chat', icon: MessageCircle },
  { key: 'nav.settings', href: '/portal/settings', icon: Settings },
  { key: 'nav.guide', href: '/portal/guide', icon: BookOpen },
]

export function PortalSidebar({ user, accounts, selectedAccountId }: PortalSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { t } = useLocale()

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/portal/login')
    router.refresh()
  }

  const displayName = user.email?.split('@')[0] ?? 'User'

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
        {accounts.length > 0 && (
          <div className="px-3 py-3 border-b">
            <CompanySwitcher
              accounts={accounts}
              selectedAccountId={selectedAccountId}
            />
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = item.href === '/portal'
              ? pathname === '/portal'
              : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900'
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {t(item.key)}
              </Link>
            )
          })}
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
