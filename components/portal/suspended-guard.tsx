'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, MessageSquare } from 'lucide-react'

interface Props {
  children: React.ReactNode
  companyName: string
}

/**
 * Renders a persistent red banner at the top of the portal when the selected
 * account is suspended. On non-chat routes it ALSO replaces the page content
 * with a "suspended" message + CTA to chat, effectively disabling all features
 * except the chat.
 *
 * Allowed routes while suspended: /portal/chat, /portal/profile,
 * /portal/change-password, /portal/settings
 */
const ALLOWED_ROUTE_PREFIXES = [
  '/portal/chat',
  '/portal/profile',
  '/portal/change-password',
  '/portal/settings',
  '/portal/login',
  '/portal/forgot-password',
  '/portal/reset-password',
]

export function SuspendedGuard({ children, companyName }: Props) {
  const pathname = usePathname() || ''
  const isAllowedRoute = ALLOWED_ROUTE_PREFIXES.some((p) => pathname.startsWith(p))

  return (
    <>
      {/* Persistent banner at the top */}
      <div className="sticky top-0 z-40 bg-red-600 text-white px-4 py-2.5 shadow-md">
        <div className="flex items-center gap-3 max-w-6xl mx-auto">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div className="flex-1 text-sm">
            <span className="font-semibold">{companyName} is currently suspended.</span>
            <span className="hidden sm:inline">
              {' '}
              Most features are disabled. Please contact support via chat to resolve.
            </span>
          </div>
          <Link
            href="/portal/chat"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-white/20 hover:bg-white/30 text-xs font-medium transition-colors"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat with support
          </Link>
        </div>
      </div>

      {/* On allowed routes, render the page normally (with the banner above) */}
      {isAllowedRoute ? (
        children
      ) : (
        /* On blocked routes, replace the page content entirely */
        <div className="flex items-center justify-center min-h-[60vh] px-6">
          <div className="max-w-md text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-red-100 flex items-center justify-center mb-4">
              <AlertTriangle className="h-7 w-7 text-red-600" />
            </div>
            <h1 className="text-xl font-semibold mb-2">Account Suspended</h1>
            <p className="text-sm text-zinc-600 mb-6">
              {companyName} is currently suspended. Portal features are disabled
              while the account is in this state. Please contact our support
              team via chat to discuss reactivation.
            </p>
            <Link
              href="/portal/chat"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              <MessageSquare className="h-4 w-4" />
              Open chat with support
            </Link>
          </div>
        </div>
      )}
    </>
  )
}
