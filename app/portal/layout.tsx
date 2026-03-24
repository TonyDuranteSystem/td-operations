import type { Metadata, Viewport } from 'next'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalActiveServices, getPortalNavVisibility, getPortalTier, getPortalTierByContact, getContactOnlyNavVisibility } from '@/lib/portal/queries'
import type { PortalNavVisibility } from '@/lib/portal/queries'
import { getLocale } from '@/lib/portal/i18n'
import { PortalSidebar } from '@/components/portal/portal-sidebar'
import { LocaleProvider } from '@/components/portal/locale-provider'
import { Providers } from '@/components/providers'
import { NotificationBell } from '@/components/portal/notification-bell'
import { OnboardingWrapper } from '@/components/portal/onboarding-wrapper'
import { PasswordGate } from '@/components/portal/password-gate'
import { cookies } from 'next/headers'
import Script from 'next/script'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#2563eb',
}

export const metadata: Metadata = {
  title: 'TD Portal',
  description: 'Tony Durante LLC — Client Portal',
  manifest: '/portal/manifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'TD Portal',
  },
}

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // No user — render children without shell (login/forgot-password/change-password pages handle their own UI)
  if (!user) {
    return <>{children}</>
  }

  // Get contact_id and accounts
  const contactId = getClientContactId(user)
  let accounts = contactId ? await getPortalAccounts(contactId) : []

  // If admin without contact_id, show empty portal (debugging mode)
  if (!isClient(user) && accounts.length === 0) {
    accounts = []
  }

  // Determine selected account (from cookie or default to first)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id
    ?? accounts[0]?.id
    ?? ''

  // Show onboarding wizard on first login
  const mustChangePassword = !!user.user_metadata?.must_change_password
  // Only show product tour for active/full tier clients, not leads/onboarding
  const showOnboarding = false // Disabled until tier-specific tour is built
  const userName = user.user_metadata?.full_name || ''
  const locale = getLocale(user)
  // Portal tier: always from contacts table (source of truth)
  const portalTier = contactId
    ? await getPortalTierByContact(contactId)
    : (user.app_metadata?.portal_tier as string) || 'lead'

  // Account-level data: only if an account is selected
  const [activeServices, navVisibility] = selectedAccountId
    ? await Promise.all([
        getPortalActiveServices(selectedAccountId),
        getPortalNavVisibility(selectedAccountId),
      ])
    : [[] as string[], getContactOnlyNavVisibility()]

  return (
    <Providers>
      <LocaleProvider locale={locale}>
        <PasswordGate mustChangePassword={mustChangePassword} />
        {showOnboarding && <OnboardingWrapper showOnboarding={true} userName={userName} />}
        <div className="flex h-screen bg-gradient-to-br from-slate-50 to-blue-50/30">
          <PortalSidebar
            user={user}
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            activeServices={activeServices}
            navVisibility={navVisibility}
            portalTier={portalTier}
          />
        <main className="flex-1 overflow-y-auto">
          <div className="h-14 lg:hidden" />
          {/* Notification bell - top right on desktop (always shown if contactId exists) */}
          {contactId && (
            <div className="hidden lg:flex justify-end px-8 pt-4">
              <NotificationBell accountId={selectedAccountId || undefined} contactId={contactId} />
            </div>
          )}
          {children}
        </main>
        </div>
      </LocaleProvider>
      {/* Iubenda Cookie Consent Banner */}
      <Script
        src="https://embeds.iubenda.com/widgets/e5dba7a9-75ac-453c-8542-ffbc914deb88.js"
        strategy="lazyOnload"
      />
    </Providers>
  )
}
