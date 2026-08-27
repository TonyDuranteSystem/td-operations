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
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'
import { PortalSidebar } from '@/components/portal/portal-sidebar'
import { OfficeClock } from '@/components/portal/office-clock'
import { countryToTimeZone } from '@/lib/portal/client-timezone'
import { getUnopenedDocsCount } from '@/lib/portal/document-alerts'
import { getToSignCount } from '@/lib/portal/signable-documents'
import { LocaleProvider } from '@/components/portal/locale-provider'
import { Providers } from '@/components/providers'
import { NotificationBell } from '@/components/portal/notification-bell'
import { PendingDecisions } from '@/components/portal/pending-decisions'
import { PushToggle } from '@/components/portal/push-toggle'
import { OnboardingWrapper } from '@/components/portal/onboarding-wrapper'
import { PullToRefresh } from '@/components/portal/pull-to-refresh'
import { PortalSwRegister } from '@/components/portal/portal-sw-register'
import { PortalWakeRefresh } from '@/components/portal/portal-wake-refresh'
import { PwaInstallPrompt } from '@/components/portal/pwa-install-prompt'
import { DashboardInstallBanner } from '@/components/portal/dashboard-install-banner'
import { EnablePushCard } from '@/components/portal/enable-push-card'
import { PasswordGate } from '@/components/portal/password-gate'
import { SuspendedGuard } from '@/components/portal/suspended-guard'
import { ViewAsBanner } from '@/components/portal/view-as-banner'
import { verifyViewAs, VIEW_AS_COOKIE } from '@/lib/portal/view-as'
import { isValidTimeZone, shouldRefreshLastSeen } from '@/lib/portal/last-seen-location'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies, headers } from 'next/headers'
import { resolvePortalMode } from '@/lib/portal/portal-mode'
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
    const [tmActiveServices, tmNavVisibility, tmTranslations] = tmSelectedAccountId
      ? await Promise.all([getPortalActiveServices(tmSelectedAccountId), getPortalNavVisibility(tmSelectedAccountId, undefined), loadTranslationsForLocale(tmLocale)])
      : [[] as string[], await getContactOnlyNavVisibility(undefined), await loadTranslationsForLocale(tmLocale)]

    return (
      <Providers>
        <SandboxBanner />
        <PortalSwRegister locale={tmLocale} />
        {/* Teammates see documents and chat through this same shell — they must
            catch up on wake too. Mounting only in the branch below would have
            silently excluded them (caught in review). */}
        <PortalWakeRefresh />
        <LocaleProvider locale={tmLocale} translations={tmTranslations}>
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
              {/* Spacer for the persistent top bar (fixed, h-14, all breakpoints
                  since the 2026-08-20 redesign — see portal-sidebar.tsx). */}
              <div className="h-14" />
              <div className="px-4 pt-4 sm:px-6 lg:px-8">
                <OfficeClock />
              </div>
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

  // Resolve the selected entity from the two selection cookies. portal_account_id
  // stays account-id-only; portal_formation (set only by the company switcher)
  // selects an in-progress formation. The contact-level tier is now only the
  // fallback when the contact has neither an account nor an in-progress formation.
  const cookieStore = await cookies()
  const cookieAccountId = cookieStore.get('portal_account_id')?.value
  const cookieFormation = cookieStore.get('portal_formation')?.value

  // Read-only "View as client": if a valid marker cookie is present, render the
  // persistent banner. The minted session is the client's, so the rest of the
  // layout already reflects exactly what the client sees. Needed BEFORE the
  // clock resolution below — a real visit and a staff View-as session prefer
  // different signals (see resolveYourTimeZone).
  const viewAsMarker = await verifyViewAs(cookieStore.get(VIEW_AS_COOKIE)?.value)

  // Office clock "YOUR TIME": resolve every signal OfficeClock might use —
  // the client's stored-country address on file, and where the client's own
  // connection actually was on their last real visit (captured below). A
  // real client visit still prefers the device's own live timezone over
  // both — see resolveYourTimeZone in lib/portal/client-timezone.ts.
  let clientTz: { tz: string; label: string } | null = null
  let lastSeenTimeZone: string | null = null
  if (contactId) {
    const { data: ctzRow } = await supabaseAdmin
      .from('contacts')
      .select('address_country, last_seen_timezone, last_seen_at')
      .eq('id', contactId)
      .maybeSingle()
    clientTz = countryToTimeZone(ctzRow?.address_country ?? null)
    lastSeenTimeZone = isValidTimeZone(ctzRow?.last_seen_timezone) ? ctzRow!.last_seen_timezone! : null

    // Passive capture on a REAL visit only — View-as runs in the STAFF's
    // browser, so its connection tells us nothing about the client.
    // Throttled so a client browsing several pages doesn't write repeatedly.
    if (!viewAsMarker && shouldRefreshLastSeen(ctzRow?.last_seen_at ?? null)) {
      const ipTimeZone = (await headers()).get('x-vercel-ip-timezone')
      if (isValidTimeZone(ipTimeZone)) {
        lastSeenTimeZone = ipTimeZone
        try {
          // Deliberately NOT routed through lib/operations/contact.ts::updateContact —
          // that helper bumps `updated_at` and writes an action_log audit row on every
          // call, both meant for genuine contact edits. This is passive telemetry that
          // can fire up to hourly per active client; going through it would make
          // "updated_at" meaningless as a real-edit signal and flood the audit trail.
          // eslint-disable-next-line no-restricted-syntax -- see comment above (P2.4)
          await supabaseAdmin
            .from('contacts')
            .update({ last_seen_timezone: ipTimeZone, last_seen_at: new Date().toISOString() })
            .eq('id', contactId)
        } catch (e) {
          console.error('[portal] failed to record last-seen timezone:', e)
        }
      }
    }
  }

  // If admin without contact_id, show empty portal (debugging mode)
  if (!isClient(user) && accounts.length === 0) {
    accounts = []
  }
  let viewAsName = ''
  if (viewAsMarker) {
    const { data: vc } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', viewAsMarker.contactId)
      .maybeSingle()
    viewAsName = vc?.full_name || 'client'
  }
  const [contactTier, portalRole] = contactId
    ? await Promise.all([getPortalTierByContact(contactId), getPortalRoleByContact(contactId)])
    : [(user.app_metadata?.portal_tier as string) || 'lead', null]

  // Dual-role (client AND partner) → cookie-driven view + a switcher. Single-role
  // users are unchanged.
  const portalModeCtx = await resolvePortalMode(
    contactId,
    accounts.length > 0 || inProgress.length > 0,
    cookieStore.get('portal_mode')?.value,
  )
  const effectivePortalRole = portalModeCtx.mode === 'partner'
    ? 'partner'
    : (portalModeCtx.dual ? 'client' : portalRole)
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
  const translations = await loadTranslationsForLocale(locale)

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

  // Tab counts, in parallel to avoid adding a serial round-trip to every page:
  //  - unreadDocsCount → Documents tab pulse + count (unopened client docs)
  //  - toSignCount     → Sign Documents tab "new" blink (lease, OA, SS-4, e-sign…)
  const [unreadDocsCount, toSignCount] = await Promise.all([
    contactId ? getUnopenedDocsCount(contactId, accounts.map(a => a.id)) : Promise.resolve(0),
    contactId && selectedAccountId
      ? getToSignCount({ selectedAccountId, contactId, userEmail: user.email })
      : Promise.resolve(0),
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
      {viewAsMarker && <ViewAsBanner clientName={viewAsName} />}
      <PortalSwRegister locale={locale} />
      <PortalWakeRefresh />
      <LocaleProvider locale={locale} translations={translations}>
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
            unreadDocsCount={unreadDocsCount}
            toSignCount={toSignCount}
            accountType={accounts.find(a => a.id === selectedAccountId)?.account_type ?? null}
            contactId={contactId || undefined}
            portalRole={effectivePortalRole}
            dualRole={portalModeCtx.dual}
            portalMode={portalModeCtx.mode}
            hasWizardPending={hasWizardPending}
            inProgress={inProgress}
            selectedFormationId={selected.kind === 'formation' ? selected.formationId : undefined}
            canManageTeam={canManageTeam}
          />
        <main className="flex-1 overflow-y-auto overscroll-y-contain">
          <PullToRefresh />
          {/* Spacer for the persistent top bar (fixed, h-14, all breakpoints
              since the 2026-08-20 redesign — see portal-sidebar.tsx). */}
          <div className="h-14" />
          {/* International office clock — shows US (ET) office time + Open/Closed
              status + the client's own local time, on every page. */}
          <div className="px-4 pt-4 sm:px-6 lg:px-8">
            <OfficeClock
              clientTimeZone={clientTz?.tz}
              clientTimeZoneLabel={clientTz?.label}
              isViewAs={!!viewAsMarker}
              lastSeenTimeZone={lastSeenTimeZone ?? undefined}
            />
          </div>
          {/* Notification bell - top right on desktop (always shown if contactId exists) */}
          {contactId && (
            <div className="hidden lg:flex items-center justify-end gap-3 px-8 pt-4">
              <PushToggle accountId={selectedAccountId || ''} compact />
              <NotificationBell accountId={selectedAccountId || undefined} contactId={contactId} />
            </div>
          )}
          {contactId && <PendingDecisions locale={locale} />}
          {isSuspended && selectedAccount ? (
            <SuspendedGuard companyName={selectedAccount.company_name}>
              {children}
            </SuspendedGuard>
          ) : (
            <>
              <DashboardInstallBanner />
              {/* Installed-app-only: one-tap push opt-in (mobile; desktop has
                  the header PushToggle). Never shows together with the install
                  banner — that one hides in standalone mode. */}
              <EnablePushCard accountId={selectedAccountId || ''} />
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
