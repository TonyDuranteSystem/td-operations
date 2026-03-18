'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  MessageSquare,
  ClipboardList,
  FileText,
  Building2,
  TrendingUp,
  Cog,
  CreditCard,
  Calendar,
  LogOut,
  Menu,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'

interface NavItem {
  name: string
  href: string
  icon: React.ElementType
  badge?: number
  adminOnly?: boolean
  featureFlag?: string
}

interface SidebarProps {
  user: { email?: string }
  isAdmin?: boolean
  badgeCounts?: { inbox: number; tasks: number }
  enabledFeatures?: string[]
}

export function Sidebar({
  user,
  isAdmin = false,
  badgeCounts,
  enabledFeatures = [],
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)

  const navigation: NavItem[] = [
    { name: 'Home', href: '/', icon: LayoutDashboard },
    { name: 'Inbox', href: '/inbox', icon: MessageSquare, badge: badgeCounts?.inbox },
    { name: 'Task Board', href: '/tasks', icon: ClipboardList, badge: badgeCounts?.tasks },
    { name: 'Tax Returns', href: '/tax-returns', icon: FileText },
    { name: 'Accounts', href: '/accounts', icon: Building2 },
    { name: 'Pipeline', href: '/pipeline', icon: TrendingUp },
    { name: 'Services', href: '/services', icon: Cog },
    { name: 'Payments', href: '/payments', icon: CreditCard },
    { name: 'Calendar', href: '/calendar', icon: Calendar },
    // Phase 2+ items gated by feature flags — add here when ready:
    // { name: 'Invoices', href: '/invoices', icon: Receipt, featureFlag: 'FEATURE_INVOICES' },
    // { name: 'Leads', href: '/leads', icon: Users, featureFlag: 'FEATURE_LEADS' },
    // { name: 'Offers', href: '/offers', icon: FileSignature, featureFlag: 'FEATURE_OFFERS' },
  ]

  const visibleNav = navigation.filter(item => {
    if (item.adminOnly && !isAdmin) return false
    if (item.featureFlag && !enabledFeatures.includes(item.featureFlag)) return false
    return true
  })

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
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
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="ml-3 font-semibold">TD Operations</span>
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
          'fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-foreground flex flex-col transition-transform lg:translate-x-0 lg:static lg:z-auto',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-sidebar-border">
          <span className="text-lg font-semibold">TD Operations</span>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1 rounded hover:bg-sidebar-accent"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map((item) => {
            const isActive = item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="flex-1">{item.name}</span>
                {item.badge != null && item.badge > 0 && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-600 text-white min-w-[20px] text-center">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Keyboard shortcut hint */}
        <div className="px-6 py-2 border-t border-sidebar-border">
          <p className="text-[10px] text-sidebar-foreground/40">
            Press <kbd className="px-1 py-0.5 bg-sidebar-accent rounded text-[9px]">{'\u2318'}K</kbd> to search
          </p>
        </div>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-sidebar-border">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-sm truncate mr-2">
              <p className="font-medium capitalize">{displayName}</p>
              <p className="text-xs text-sidebar-foreground/50 truncate">{user.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded hover:bg-sidebar-accent shrink-0"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
