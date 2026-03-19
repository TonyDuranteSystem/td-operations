import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { PortalSidebar } from '@/components/portal/portal-sidebar'
import { Providers } from '@/components/providers'
import { NotificationBell } from '@/components/portal/notification-bell'
import { OnboardingWrapper } from '@/components/portal/onboarding-wrapper'
import { cookies } from 'next/headers'

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // No user — render children without shell (login/forgot-password pages handle their own UI)
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
  const showOnboarding = isClient(user) && !user.user_metadata?.onboarding_completed
  const userName = user.user_metadata?.full_name || ''

  return (
    <Providers>
      {showOnboarding && <OnboardingWrapper showOnboarding={true} userName={userName} />}
      <div className="flex h-screen bg-gradient-to-br from-slate-50 to-blue-50/30">
        <PortalSidebar
          user={user}
          accounts={accounts}
          selectedAccountId={selectedAccountId}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="h-14 lg:hidden" />
          {/* Notification bell - top right on desktop */}
          {selectedAccountId && (
            <div className="hidden lg:flex justify-end px-8 pt-4">
              <NotificationBell accountId={selectedAccountId} />
            </div>
          )}
          {children}
        </main>
      </div>
    </Providers>
  )
}
