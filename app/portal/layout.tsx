import type { Metadata, Viewport } from 'next'
import { SandboxBanner } from '@/components/sandbox-banner'
import { createClient } from '@/lib/supabase/server'
import { isClient } from '@/lib/auth'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalActiveServices, getPortalNavVisibility, getPortalTierByContact, getPortalRoleByContact, getContactOnlyNavVisibility, getUnreadChatCount, getInProgressFormations, getPortalAccountById } from '@/lib/portal/queries'
import { resolveSelectedEntity } from '@/lib/portal/select-entity'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { computeHasWizardPending } from '@/lib/portal/wizard-visibility'
import { getLocale } from '@/lib/portal/i18n'
import { PortalSidebar } from '@/components/portal/portal-sidebar'
import { LocaleProvider } from '@/components/portal/locale-provider'
import { Providers } from '@/components/providers'
import { NotificationBell } from '@/components/portal/notification-bell'
import { PushToggle } from '@/components/portal/push-toggle'
import { OnboardingWrapper } from '@/components/portal/onboarding-wrapper'
import { PullToRefresh } from '@/components/portal/pull-to-refresh'
import { PortalSwRegister } from '@/components/portal/portal-sw-register'
import { PwaInstallPrompt } from '@/components/portal/pwa-install-prompt'
import { DashboardInstallBanner } from '@/components/portal/dashboard-install-banner'
import { PasswordGate } from '@/components/portal/password-gate'
import { SuspendedGuard } from '@/components/portal/suspended-guard'
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
  manifest: '/portal/manifest.webmanifest',
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
    return <><SandboxBanner />{children}</>
  }

  // ── Teammate (Portal Team Access) — scoped to ONE company; nav filtered by capability ──
  if ((user.app_metadata as Record<string, unknown>)?.kind === 'team_member') {
    const identity = await resolvePortalIdentity(user)
    const tmLocale = getLocale(user)
    if (identity.kind !== 'teammate') {
      // Revoked / not found → no access.
      return (
        <><SandboxBanner />
          <div className="min-h-screen flex items-center justify-center p-8 text-center text-sm text-zinc-500">
            Your access has been removed. Please contact the company owner.
          </div>
        </>
      )
    }
    const tmAccount = await getPortalAccountById(identity.accountId)
    const tmAccounts = tmAccount ? [tmAccount] : []
    const tmSelectedAccountId = tmAccount?.id ?? ''
    const tmTier = tmAccount?.portal_tier ?? 'active'
    const tmSuspended = tmAccount?.status === 'Suspended'
    const [tmActiveServices, tmNavVisibility] = tmSelectedAccountId
      ? await Promise.all([getPortalActiveServices(tmSelectedAccountId), getPortalNavVisibility(tmSelectedAccountId, undefined)])
      : [[] as string[], await getContactOnlyNavVisibility(undefined)]

    return (
      <Providers>
        <SandboxBanner />
        <PortalSwRegister locale={tmLocale} />
        <LocaleProvider locale={tmLocale}>
          <div className="flex h-screen bg-gradient-to-br from-slate-50 to-blue-50/30">
            <PortalSidebar
              user={user}
              accounts={tmAccounts}
              selectedAccountId={tmSelectedAccountId}
              activeServices={tmActiveServices}
              navVisibility={tmNavVisibility}
              portalTier={tmTier}
              accountType={tmAccount?.account_type ?? null}
              hasWizardPending={false}
              canManageTeam={false}
              isTeammate={true}
              teammateCapabilities={identity.capabilities}
            />
            <main className="flex-1 overflow-y-auto overscroll-y-contain">
              <div className="h-14 lg:hidden" />
              {tmSuspended && tmAccount ? (
                <SuspendedGuard companyName={tmAccount.company_name}>{children}</SuspendedGuard>
              ) : children}
            </main>
          </div>
        </LocaleProvider>
      </Providers>
    )
  }

  // Get contact_id, accounts, and in-progress formations (per-entity portal:
  // a client can hold real companies AND a company being formed that has no
  // account yet — both are selectable, each with its own stage).
  const contactId = getClientContactId(user)
  let accounts = contactId ? await getPortalAccounts(contactId) : []
  const inProgress = contactId ? await getInProgressFormations(contactId) : []

  // If admin without contact_id, show empty portal (debugging mode)
  if (!isClient(user) && accounts.length === 0) {
    accounts = []
  }

  // Resolve the selected entity from the two selection cookies. portal_account_id
  // stays account-id-only; portal_formation (set only by the company switcher)
  // selects an in-progress formation. The contact-level tier is now only the
  // fallback when the contact has neither an account nor an in-progress formation.
  const cookieStore = await cookies()
  const cookieAccountId = cookieStore.get('portal_account_id')?.value
  const cookieFormation = cookieStore.get('portal_formation')?.value
  const [contactTier, portalRole] = contactId
    ? await Promise.all([getPortalTierByContact(contactId), getPortalRoleByContact(contactId)])
    : [(user.app_metadata?.portal_tier as string) || 'lead', null]
  const selected = resolveSelectedEntity({
    accounts, inProgress, accountCookie: cookieAccountId, formationCookie: cookieFormation, fallbackTier: contactTier,
  })
  const selectedAccountId = selected.kind === 'account' ? selected.accountId : ''
  const selectedAccount = selected.kind === 'account' ? selected.account : undefined
  const portalTier = selected.tier
  const isSuspended = selectedAccount?.status === 'Suspended'

  // Show onboarding wizard on first login
  const mustChangePassword = !!user.user_metadata?.must_change_password
  // Only show product tour for active/full tier clients, not leads/onboarding
  const showOnboarding = false // Disabled until tier-specific tour is built
  const userName = user.user_metadata?.full_name || ''
  const locale = getLocale(user)

  // Account-level data: only if an account is selected
  // Phase C (ITIN Chain Fix 2026-05-11): pass contactId so the ITIN-at-Client-
  // Signing flag can light up. ITIN SDs are contact-scoped, so they exist
  // whether or not the contact has an account.
  const [activeServices, navVisibility, unreadChatCount] = selectedAccountId
    ? await Promise.all([
        getPortalActiveServices(selectedAccountId),
        getPortalNavVisibility(selectedAccountId, contactId || undefined),
        contactId ? getUnreadChatCount(contactId) : Promise.resolve(0),
      ])
    : await Promise.all([
        Promise.resolve([] as string[]),
        getContactOnlyNavVisibility(contactId || undefined),
        contactId ? getUnreadChatCount(contactId) : Promise.resolve(0),
      ])

  // "Complete Setup" sidebar visibility — see lib/portal/wizard-visibility.ts
  // for the three branches (SD-by-account, SD-by-contact, tier-based
  // onboarding fallback per SOP v7.2 Phase 0).
  const hasWizardPending = await computeHasWizardPending({
    contactId: contactId || null,
    selectedAccountId,
    portalTier,
  })

  // Team tab is visible only to the account admin (main person) of the selected company.
  const canManageTeam = !!contactId && !!selectedAccountId
    ? await isAccountAdmin(contactId, selectedAccountId)
    : false

  return (
    <Providers>
      <SandboxBanner />
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
            inProgress={inProgress}
            selectedFormationId={selected.kind === 'formation' ? selected.formationId : undefined}
            canManageTeam={canManageTeam}
          />
        <main className="flex-1 overflow-y-auto overscroll-y-contain">
          <PullToRefresh />
          <div className="h-14 lg:hidden" />
          {/* Notification bell - top right on desktop (always shown if contactId exists) */}
          {contactId && (
            <div className="hidden lg:flex items-center justify-end gap-3 px-8 pt-4">
              <PushToggle accountId={selectedAccountId || ''} compact />
              <NotificationBell accountId={selectedAccountId || undefined} contactId={contactId} />
            </div>
          )}
          {isSuspended && selectedAccount ? (
            <SuspendedGuard companyName={selectedAccount.company_name}>
              {children}
            </SuspendedGuard>
          ) : (
            <>
              <DashboardInstallBanner />
              {children}
            </>
          )}
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
