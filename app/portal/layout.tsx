import type { Metadata, Viewport } from 'next'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalActiveServices, getPortalNavVisibility, getPortalTierByContact, getPortalRoleByContact, getContactOnlyNavVisibility, getUnreadChatCount } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getLocale } from '@/lib/portal/i18n'
import { PortalSidebar } from '@/components/portal/portal-sidebar'
import { LocaleProvider } from '@/components/portal/locale-provider'
import { Providers } from '@/components/providers'
import { NotificationBell } from '@/components/portal/notification-bell'
import { OnboardingWrapper } from '@/components/portal/onboarding-wrapper'
import { PullToRefresh } from '@/components/portal/pull-to-refresh'
import { PortalSwRegister } from '@/components/portal/portal-sw-register'
import { PwaInstallPrompt } from '@/components/portal/pwa-install-prompt'
import { PasswordGate } from '@/components/portal/password-gate'
import { cookies } from 'next/headers'
import Script from 'next/script'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#BE1E2D',
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
  // Portal tier + role: always from contacts table (source of truth)
  const [portalTier, portalRole] = contactId
    ? await Promise.all([getPortalTierByContact(contactId), getPortalRoleByContact(contactId)])
    : [(user.app_metadata?.portal_tier as string) || 'lead', null]

  // Account-level data: only if an account is selected
  const [activeServices, navVisibility, unreadChatCount] = selectedAccountId
    ? await Promise.all([
        getPortalActiveServices(selectedAccountId),
        getPortalNavVisibility(selectedAccountId),
        getUnreadChatCount(selectedAccountId, contactId || ''),
      ])
    : [[] as string[], getContactOnlyNavVisibility(), contactId ? await getUnreadChatCount(null, contactId) : 0]

  // Check if there are pending wizard-eligible service deliveries (Banking, ITIN, Tax, Formation, Closure)
  const WIZARD_SERVICE_TYPES = ['Company Formation', 'Banking Fintech', 'Company Closure', 'ITIN', 'ITIN Renewal', 'Tax Return']
  let hasWizardPending = false
  if (selectedAccountId) {
    const { data: wizardSds } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_type')
      .eq('account_id', selectedAccountId)
      .in('status', ['active'])
      .in('service_type', WIZARD_SERVICE_TYPES)
      .limit(1)
    hasWizardPending = (wizardSds?.length ?? 0) > 0
  }

  return (
    <Providers>
      <PortalSwRegister locale={locale} />
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
            unreadChatCount={unreadChatCount}
            accountType={accounts.find(a => a.id === selectedAccountId)?.account_type ?? null}
            contactId={contactId || undefined}
            portalRole={portalRole}
            hasWizardPending={hasWizardPending}
          />
        <main className="flex-1 overflow-y-auto overscroll-y-contain">
          <PullToRefresh />
          <div className="h-14 lg:hidden" />
          {/* Notification bell - top right on desktop (always shown if contactId exists) */}
          {contactId && (
            <div className="hidden lg:flex justify-end px-8 pt-4">
              <NotificationBell accountId={selectedAccountId || undefined} contactId={contactId} />
            </div>
          )}
          {children}
        </main>
        <PwaInstallPrompt />
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
