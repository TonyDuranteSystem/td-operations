export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalServices, getPortalDeadlines, getPortalPayments, getPortalPaymentsByContact, getPortalTaxReturns, getPortalMembers, getPortalTier, getPortalActionItems, getPortalActionItemsByContact, getProfileBannerStatus, getFormationAccount, getFormationContext, getFormationTracker, getInProgressFormations, getTaxTrackerCatalogStages, getPortalFlows } from '@/lib/portal/queries'
import { buildFormationTrackerSteps } from '@/lib/portal/formation-progress'
import { buildTrackerSteps } from '@/lib/tax/progress-tracker'
import { TaxProgressTracker } from '@/components/portal/tax-progress-tracker'
import { FlowProgressTracker } from '@/components/portal/flow-progress-tracker'
import { PortalFlowStatusSection } from '@/components/portal/flow-status-section'
import { ActionItems } from '@/components/portal/action-items'
import { Building2, Shield, MapPin, Calendar, FileText, Clock, CheckCircle2, Mail, Phone, User, ChevronRight, ListChecks } from 'lucide-react'
import Link from 'next/link'
import { PaymentHistory } from '@/components/portal/payment-history'
import { cn } from '@/lib/utils'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getBankReferralsForAccount } from '@/lib/bank-referrals'
import { WelcomeDashboard } from './welcome-dashboard'
import { FormationDashboard } from '@/components/portal/formation-dashboard'
import { TaxBanner } from '@/components/portal/tax-banner'
import { TaxExtensionFiledBanner } from '@/components/portal/tax-extension-filed-banner'
import { GuideAnnouncementBanner } from '@/components/portal/guide-announcement-banner'
import { TeamAccessAnnouncementBanner } from '@/components/portal/team-access-announcement-banner'
import { WhatsNewBanner } from '@/components/portal/whats-new-banner'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { ProfileCompletionBanner } from '@/components/portal/profile-completion-banner'
import { RenewalBanner } from '@/components/portal/renewal-banner'
import { MemberInfoBanner } from '@/components/portal/member-info-banner'
import { OfferBanner } from '@/components/portal/offer-banner'
import { AnnouncementBanners, type PortalAnnouncement } from '@/components/portal/announcement-banners'
import { APP_BASE_URL } from '@/lib/config'
import { resolveExtensionDeadline, formatDeadlineForDisplay } from '@/lib/tax/extension-deadline'
import { differenceInDays, parseISO, format } from 'date-fns'
import { getRenewalBannerMinYear } from '@/lib/settings'

function formatEin(ein: string | null): string {
  if (!ein) return '\u2014'
  return ein
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  try {
    return format(parseISO(d), 'MMM d, yyyy')
  } catch {
    return d
  }
}

const STATUS_COLORS: Record<string, string> = {
  'Not Started': 'bg-zinc-100 text-zinc-600',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Waiting Client': 'bg-amber-100 text-amber-700',
  'Waiting Third Party': 'bg-orange-100 text-orange-700',
  'Completed': 'bg-emerald-100 text-emerald-700',
  'Cancelled': 'bg-zinc-100 text-zinc-500',
  'active': 'bg-blue-100 text-blue-700',
  'blocked': 'bg-red-100 text-red-700',
  'completed': 'bg-emerald-100 text-emerald-700',
  'cancelled': 'bg-zinc-100 text-zinc-500',
  'Paid': 'bg-emerald-100 text-emerald-700',
  'Due': 'bg-amber-100 text-amber-700',
  'Overdue': 'bg-red-100 text-red-700',
  'Pending': 'bg-amber-100 text-amber-700',
}

export default async function PortalDashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  const locale = getLocale(user)

  // ITIN is contact-scoped (account_id NULL), so a formation-tier client who
  // also has an ITIN would never see it: the formation branches below return
  // FormationDashboard early, before the account/lead Service Status sections.
  // Load the contact's active ITIN flow(s) here so each FormationDashboard
  // return can render them alongside (see PortalFlowStatusSection usages). Cheap:
  // one contact-scoped query, only run for the formation branches that call it.
  const loadItinFlows = async () =>
    contactId
      ? (await getPortalFlows('', locale, contactId)).filter(f => f.flow_type === 'ITIN')
      : []

  // Teammate (Portal Team Access) — a simple scoped landing. Granted sections are
  // reached via the (capability-filtered) sidebar; the overview's contact-centric
  // data fetch does not apply to teammates.
  if (!contactId && (user.app_metadata as Record<string, unknown>)?.kind === 'team_member') {
    const { resolvePortalIdentity } = await import('@/lib/portal/resolve-portal-identity')
    const { getPortalAccountById } = await import('@/lib/portal/queries')
    const identity = await resolvePortalIdentity(user)
    if (identity.kind !== 'teammate') redirect('/portal/login')
    const account = await getPortalAccountById(identity.accountId)
    const who = typeof user.user_metadata?.display_name === 'string' ? user.user_metadata.display_name : ''
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="bg-white rounded-xl border shadow-sm p-8">
          <h1 className="text-xl font-semibold text-zinc-900">Welcome{who ? `, ${who}` : ''}</h1>
          <p className="text-sm text-zinc-500 mt-2">
            You have access to <span className="font-medium">{account?.company_name ?? 'this company'}</span>&rsquo;s portal.
            Use the menu to open the sections you&rsquo;ve been given access to.
          </p>
        </div>
      </div>
    )
  }

  // Partners have their own section. A dual-role person (client AND partner)
  // only redirects when they're in PARTNER mode (portal_mode cookie); in client
  // mode they see this client dashboard.
  if (contactId) {
    const { resolvePortalMode } = await import('@/lib/portal/portal-mode')
    const { count: membershipCount } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
    const cookieStore = await cookies()
    const modeCtx = await resolvePortalMode(contactId, (membershipCount ?? 0) > 0, cookieStore.get('portal_mode')?.value)
    if (modeCtx.mode === 'partner') redirect('/portal/partner/clients')
  }

  // Get accounts (may be empty for leads)
  const accounts = contactId ? await getPortalAccounts(contactId) : []

  // Get selected account
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.length > 0
    ? (accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0].id)
    : ''

  // Per-entity: an explicitly selected in-progress formation (set by the company
  // switcher) renders its contact-scoped formation dashboard regardless of any
  // account the client also owns. Additive — only fires when portal_formation is
  // set AND matches a current in-progress formation; otherwise the existing
  // account/lead/onboarding logic below runs unchanged.
  const cookieFormation = (await cookieStore).get('portal_formation')?.value
  if (contactId && cookieFormation) {
    const inProgress = await getInProgressFormations(contactId)
    const selectedFormation = inProgress.find(f => f.id === cookieFormation)
    if (selectedFormation) {
      const firstName = user.user_metadata?.full_name?.split(' ')[0] || user.app_metadata?.full_name?.split(' ')[0] || user.email?.split('@')[0] || 'Client'
      const ctx = await getFormationContext(contactId)
      const tracker = await getFormationTracker({ sdId: selectedFormation.sdId })
      const trackerSteps = tracker?.currentStage
        ? buildFormationTrackerSteps(tracker.stages, tracker.currentStage, locale, tracker.filedAt, tracker.faxedAt)
        : null
      const itinFlows = await loadItinFlows()
      return (
        <div className="space-y-4">
          {itinFlows.length > 0 && (
            <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0">
              <PortalFlowStatusSection flows={itinFlows} locale={locale} />
            </div>
          )}
          <FormationDashboard
            firstName={firstName}
            locale={locale}
            account={null}
            wizardData={ctx.wizard}
            ss4Data={ctx.ss4}
            oaData={ctx.oa}
            leaseData={ctx.lease}
            trackerSteps={trackerSteps}
            formationLeadId={selectedFormation.leadId}
            sdStage={tracker?.currentStage ?? null}
            filedAt={tracker?.filedAt ?? null}
          />
        </div>
      )
    }
  }

  // Check tier
  const portalTier = selectedAccountId
    ? await getPortalTier(selectedAccountId)
    : 'lead' // No account = lead tier

  // Lead/onboarding without account = show welcome dashboard
  if (!selectedAccountId || accounts.length === 0) {
    // No account yet — check auth metadata for portal_tier (set by portal_create_user)
    const authTier = (user.app_metadata?.portal_tier as string) || 'lead'
    const firstName = user.user_metadata?.full_name?.split(' ')[0] || user.app_metadata?.full_name?.split(' ')[0] || user.email?.split('@')[0] || 'Client'

    // Find offer by email
    const emails = new Set<string>()
    if (user.email) emails.add(user.email)
    const emailArr = Array.from(emails)

    let offerData = null
    if (emailArr.length > 0) {
      const { data: offer } = await supabaseAdmin
        .from('offers')
        .select('token, client_name, status, services, cost_summary, recurring_costs, bundled_pipelines, contract_type, language, payment_links, bank_details, payment_type')
        .in('client_email', emailArr)
        .not('status', 'eq', 'expired')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (offer) {
        offerData = offer
      } else {
        // Try via lead
        const { data: leads } = await supabaseAdmin
          .from('leads')
          .select('id')
          .in('email', emailArr)
          .limit(1)

        if (leads?.length) {
          const { data: leadOffer } = await supabaseAdmin
            .from('offers')
            .select('token, client_name, status, services, cost_summary, recurring_costs, bundled_pipelines, contract_type, language, payment_links, bank_details, payment_type')
            .eq('lead_id', leads[0].id)
            .not('status', 'eq', 'expired')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          offerData = leadOffer
        }
      }
    }

    // Formation tier with no Active/Suspended account.
    //
    // Two modes:
    //   1. Legacy: a 'Pending Formation' placeholder account exists from the
    //      old activate-service flow (excluded from getPortalAccounts which
    //      only returns Active/Suspended). Query progress by account_id.
    //   2. Post-PR1 (Antonio's model): no account exists at all until Articles
    //      of Organization arrive in Drive. Query progress by contact_id.
    //
    // Either way we render the same FormationDashboard. The component already
    // accepts account=null.
    // Show the formation dashboard when EITHER the auth tier says formation OR
    // (authoritative) the contact has an active Company Formation service
    // delivery. The auth-metadata tier is unreliable here — it can be stale
    // (e.g. left at 'active' after a prior formation completed) or never set —
    // whereas the formation SD exists from "Payment Confirmed" onward, so it's
    // the reliable signal that drives the 7-stage tracker at ANY stage. Reuses
    // getInProgressFormations (1 query when there's no formation SD, so it's
    // free for ordinary leads/onboarding clients). Short-circuits the lookup
    // when the tier already says formation.
    const hasActiveFormation =
      authTier !== 'formation' &&
      !!contactId &&
      (await getInProgressFormations(contactId)).length > 0
    if ((authTier === 'formation' || hasActiveFormation) && contactId) {
      const formationAccount = await getFormationAccount(contactId)
      // Contact-scoped Company Closure SD — surfaces a Closure CTA on the
      // formation dashboard when the same client also has an external LLC
      // being closed alongside the new formation. Patrick Covelli pattern.
      const { data: closureSd } = await supabaseAdmin
        .from('service_deliveries')
        .select('id')
        .eq('contact_id', contactId)
        .is('account_id', null)
        .eq('service_type', 'Company Closure')
        .eq('status', 'active')
        .limit(1)
        .maybeSingle()
      if (formationAccount) {
        const [wizardRes, ss4Res, oaRes, leaseRes] = await Promise.all([
          supabaseAdmin
            .from('wizard_progress')
            .select('id, status')
            .eq('account_id', formationAccount.id)
            .eq('wizard_type', 'formation')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabaseAdmin
            .from('ss4_applications')
            .select('id, status')
            .eq('account_id', formationAccount.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabaseAdmin
            .from('oa_agreements')
            .select('id, status')
            .eq('account_id', formationAccount.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabaseAdmin
            .from('lease_agreements')
            .select('id, status')
            .eq('account_id', formationAccount.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ])
        const tracker = await getFormationTracker({ accountId: formationAccount.id, contactId })
        const trackerSteps = tracker?.currentStage
          ? buildFormationTrackerSteps(tracker.stages, tracker.currentStage, locale, tracker.filedAt, tracker.faxedAt)
          : null
        const itinFlows = await loadItinFlows()
        return (
          <div className="space-y-4">
            {itinFlows.length > 0 && (
              <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0">
                <PortalFlowStatusSection flows={itinFlows} locale={locale} />
              </div>
            )}
            <FormationDashboard
              firstName={firstName}
              locale={locale}
              account={formationAccount}
              wizardData={wizardRes.data}
              ss4Data={ss4Res.data}
              oaData={oaRes.data}
              leaseData={leaseRes.data}
              closureData={closureSd}
              trackerSteps={trackerSteps}
              sdStage={tracker?.currentStage ?? null}
              filedAt={tracker?.filedAt ?? null}
            />
          </div>
        )
      }

      // Post-PR1 path: no account, contact-scoped reads.
      const ctx = await getFormationContext(contactId)
      const tracker = await getFormationTracker({ contactId })
      const trackerSteps = tracker?.currentStage
        ? buildFormationTrackerSteps(tracker.stages, tracker.currentStage, locale, tracker.filedAt, tracker.faxedAt)
        : null
      const itinFlows = await loadItinFlows()
      return (
        <div className="space-y-4">
          {itinFlows.length > 0 && (
            <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0">
              <PortalFlowStatusSection flows={itinFlows} locale={locale} />
            </div>
          )}
          <FormationDashboard
            firstName={firstName}
            locale={locale}
            account={null}
            wizardData={ctx.wizard}
            ss4Data={ctx.ss4}
            oaData={ctx.oa}
            leaseData={ctx.lease}
            closureData={closureSd}
            trackerSteps={trackerSteps}
            sdStage={tracker?.currentStage ?? null}
            filedAt={tracker?.filedAt ?? null}
          />
        </div>
      )
    }

    // Check if an onboarding wizard submission is already in for this contact —
    // used by the welcome dashboard to flip step 4 from "Complete Setup" link
    // into a passive "Data submitted — we're reviewing" state (Tier Model B).
    let wizardSubmitted = false
    if (contactId) {
      const { data: wp } = await supabaseAdmin
        .from('wizard_progress')
        .select('id')
        .eq('contact_id', contactId)
        .in('wizard_type', ['onboarding', 'formation'])
        .eq('status', 'submitted')
        .limit(1)
        .maybeSingle()
      wizardSubmitted = !!wp
    }

    // Pending actions for clients who have a portal account but no active
    // account yet (e.g. onboarding tier waiting for wizard review). Uses the
    // contact-scoped helper because the regular getPortalActionItems requires
    // an accountId — passing undefined silently returned nothing (broken
    // before PR 2). Surfaces in-progress wizards + contact-scoped unpaid
    // invoices, which is everything that exists at this stage.
    const noAccountActionItems = contactId
      ? await getPortalActionItemsByContact(contactId)
      : { items: [], counts: { red: 0, orange: 0, blue: 0, total: 0 } }

    // ITIN-only clients (no account/LLC) still have a contact-scoped ITIN flow.
    // Surface it as a Service Status section above the welcome dashboard so they
    // can track it. Passing '' as accountId makes getPortalFlows skip the
    // account query and return only the contact-scoped (ITIN) flows.
    const noAccountFlows = contactId ? await getPortalFlows('', locale, contactId) : []

    return (
      <>
        {noAccountActionItems.items.length > 0 && (
          <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0">
            <ActionItems data={noAccountActionItems} locale={locale} />
          </div>
        )}
        {noAccountFlows.length > 0 && (
          <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-2 px-1">
              <ListChecks className="h-4 w-4 text-zinc-400" />
              {locale === 'it' ? 'Stato dei Servizi' : 'Service Status'}
            </h2>
            {noAccountFlows.map(f =>
              f.steps ? (
                <FlowProgressTracker key={f.id} title={f.title} steps={f.steps} href={`/portal/flows/${f.id}`} />
              ) : (
                <Link
                  key={f.id}
                  href={`/portal/flows/${f.id}`}
                  className="bg-white rounded-xl border shadow-sm p-5 flex items-center justify-between gap-2 hover:border-zinc-300 transition-colors"
                >
                  <span className="text-sm font-medium text-zinc-900">{f.title}</span>
                  <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                    {locale === 'it' ? 'Attivo' : 'Active'}
                  </span>
                </Link>
              )
            )}
          </div>
        )}
        <WelcomeDashboard
          tier={authTier}
          firstName={firstName}
          offerData={offerData}
          locale={locale}
          wizardSubmitted={wizardSubmitted}
        />
      </>
    )
  }

  // Formation tier with an Active account (LLC formed but portal_tier not yet promoted).
  // Uses selectedAccountId since the account is visible in getPortalAccounts.
  if (portalTier === 'formation') {
    const firstName = user.user_metadata?.full_name?.split(' ')[0] || user.email?.split('@')[0] || 'Client'
    const [accountRes, wizardRes, ss4Res, oaRes, leaseRes] = await Promise.all([
      getPortalAccountDetail(selectedAccountId),
      supabaseAdmin
        .from('wizard_progress')
        .select('id, status')
        .eq('account_id', selectedAccountId)
        .eq('wizard_type', 'formation')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('ss4_applications')
        .select('id, status')
        .eq('account_id', selectedAccountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('oa_agreements')
        .select('id, status')
        .eq('account_id', selectedAccountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('lease_agreements')
        .select('id, status')
        .eq('account_id', selectedAccountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    const tracker = await getFormationTracker({ accountId: selectedAccountId, contactId })
    const trackerSteps = tracker?.currentStage
      ? buildFormationTrackerSteps(tracker.stages, tracker.currentStage, locale, tracker.filedAt, tracker.faxedAt)
      : null
    const itinFlows = await loadItinFlows()
    return (
      <div className="space-y-4">
        {itinFlows.length > 0 && (
          <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0">
            <PortalFlowStatusSection flows={itinFlows} locale={locale} />
          </div>
        )}
        <FormationDashboard
          firstName={firstName}
          locale={locale}
          account={accountRes ? {
            id: accountRes.id,
            company_name: accountRes.company_name,
            entity_type: accountRes.entity_type,
            state_of_formation: accountRes.state_of_formation,
            formation_date: accountRes.formation_date,
            filing_id: accountRes.filing_id,
            status: accountRes.status,
            ein_number: accountRes.ein_number,
          } : null}
          wizardData={wizardRes.data}
          ss4Data={ss4Res.data}
          oaData={oaRes.data}
          leaseData={leaseRes.data}
          trackerSteps={trackerSteps}
          sdStage={tracker?.currentStage ?? null}
          filedAt={tracker?.filedAt ?? null}
        />
      </div>
    )
  }

  if (portalTier === 'lead' || portalTier === 'onboarding') {
    // Get offer data for welcome dashboard
    // Collect all possible emails: auth email + contact email
    const emails = new Set<string>()
    if (user.email) emails.add(user.email)
    if (contactId) {
      const { data: contactData } = await supabaseAdmin
        .from('contacts')
        .select('email')
        .eq('id', contactId)
        .single()
      if (contactData?.email) emails.add(contactData.email)
    }

    let offerData = null
    const emailArr = Array.from(emails)

    // Try finding offer by any matching email
    if (emailArr.length > 0) {
      const { data: offer } = await supabaseAdmin
        .from('offers')
        .select('token, client_name, status, services, cost_summary, recurring_costs, bundled_pipelines, contract_type, language, payment_links, bank_details, payment_type')
        .in('client_email', emailArr)
        .not('status', 'eq', 'expired')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (offer) {
        offerData = offer
      } else {
        // Try via lead
        const { data: leads } = await supabaseAdmin
          .from('leads')
          .select('id')
          .in('email', emailArr)
          .limit(1)

        if (leads?.length) {
          const { data: leadOffer } = await supabaseAdmin
            .from('offers')
            .select('token, client_name, status, services, cost_summary, recurring_costs, bundled_pipelines, contract_type, language, payment_links, bank_details, payment_type')
            .eq('lead_id', leads[0].id)
            .not('status', 'eq', 'expired')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          offerData = leadOffer
        }
      }
    }

    const firstName = user.user_metadata?.full_name?.split(' ')[0] || user.email?.split('@')[0] || 'Client'

    // Check if an onboarding wizard submission is already in for this
    // contact — used by the welcome dashboard to flip step 4 from "Complete
    // Setup" link into a passive "Data submitted — we're reviewing" state
    // (Tier Model B). We key off contact_id because the wizard belongs to
    // the person: pre-account wizards have account_id=NULL (e.g. Luca
    // Gallacci 2026-04-18 case) and post-promote rows still keep contact_id.
    let wizardSubmitted = false
    if (contactId) {
      const { data: wp } = await supabaseAdmin
        .from('wizard_progress')
        .select('id')
        .eq('contact_id', contactId)
        .in('wizard_type', ['onboarding', 'formation'])
        .eq('status', 'submitted')
        .limit(1)
        .maybeSingle()
      wizardSubmitted = !!wp
    }

    // Pending actions (signatures, invoices, wizards) for pre-active tier clients.
    // Rendered above the WelcomeDashboard when non-empty so items like a pending
    // SS-4 surface on the home page instead of being stranded behind the
    // sidebar's Sign Documents entry (which may be hidden by stale sessions).
    const actionItems = await getPortalActionItems(selectedAccountId, contactId || undefined)

    return (
      <>
        {actionItems.items.length > 0 && (
          <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0">
            <ActionItems data={actionItems} locale={locale} />
          </div>
        )}
        <WelcomeDashboard
          tier={portalTier}
          firstName={firstName}
          offerData={offerData}
          locale={locale}
          wizardSubmitted={wizardSubmitted}
        />
      </>
    )
  }

  // Renewal-banner gate: show only when current calendar year >= app_settings
  // 'renewal_banner_min_year' (default 2027). Hides 2026 banner during legacy
  // payment purgatory; Antonio bumps higher in Dev Tools to extend the hide.
  const renewalBannerMinYear = await getRenewalBannerMinYear()
  const currentYear = new Date().getUTCFullYear()
  const renewalBannerEnabled = currentYear >= renewalBannerMinYear

  // Fetch all data in parallel
  const [account, services, deadlines, accountPayments, contactPayments, taxReturns, members, actionItems, profileBanner, renewalOffer] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalServices(selectedAccountId),
    getPortalDeadlines(selectedAccountId),
    getPortalPayments(selectedAccountId),
    contactId ? getPortalPaymentsByContact(contactId) : Promise.resolve([]),
    getPortalTaxReturns(selectedAccountId),
    getPortalMembers(selectedAccountId),
    getPortalActionItems(selectedAccountId, contactId || undefined),
    contactId ? getProfileBannerStatus(contactId) : Promise.resolve({ shouldShow: false, missingFields: [] as string[] }),
    // Unsigned annual agreement for active clients — shown as a banner until signed
    // Skipped entirely when the year-gate is closed (renewalBannerEnabled=false).
    !renewalBannerEnabled
      ? Promise.resolve(null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (supabaseAdmin as any)
          .from('annual_agreements')
          .select('token')
          .eq('account_id', selectedAccountId)
          .eq('agreement_year', currentYear)
          .not('status', 'in', '("signed","completed","expired")')
          .limit(1)
          .maybeSingle()
          .then((r: { data: { token: string } | null }) => r.data ?? null) as Promise<{ token: string } | null>,
  ])
  // Tax progress tracker (Slice 5) — catalog stages fetched only when there is
  // an in-flight tax return with a known SD stage; buildTrackerSteps decides
  // visibility (null = hide: pre-installment, terminated, legacy stage names).
  const trackerTr = taxReturns.find(tr => tr.sd_stage != null) ?? null
  const trackerSteps = trackerTr
    ? buildTrackerSteps(await getTaxTrackerCatalogStages(), trackerTr.sd_stage, locale, trackerTr.review_status)
    : null

  // Pending member info request — separate to avoid TypeScript tuple depth limit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pendingMemberInfoRequest } = await (supabaseAdmin as any)
    .from('member_info_requests')
    .select('token, access_code')
    .eq('account_id', selectedAccountId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle() as { data: { token: string; access_code: string } | null }
  // Pending offer for active-tier clients — shown as a persistent banner until
  // the offer is completed or expired. Queried by portal login email so it works
  // even before contact.email is normalised (same email used at offer creation).
  const pendingOffer = user.email
    ? await supabaseAdmin
        .from('offers')
        .select('token')
        .eq('client_email', user.email)
        .in('status', ['sent', 'viewed'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(r => r.data ?? null)
    : null

  // Partner-bank referrals — separate await because the generated Supabase
  // types don't yet cover bank_referrals/bank_referral_clicks. The helper
  // in lib/bank-referrals.ts swallows errors so a missing schema in any
  // environment just renders an empty "Partner Banks" section.
  const bankReferrals = await getBankReferralsForAccount(selectedAccountId)

  // Service Status — client-facing flow progress (Tax Return / Annual Report /
  // RA Renewal / CMRA) driven by active service_deliveries + per-stage
  // client_label. Distinct from the services-table "Services" card below.
  const flows = await getPortalFlows(selectedAccountId, locale, contactId)
  // The dedicated Slice-5 Tax tracker (below) already renders the Tax Return
  // journey, so drop Tax Return from Service Status when it's showing to avoid
  // two Tax Return steppers on the same page.
  const taxTrackerShown = !!(trackerSteps && trackerTr)
  const flowsForStatus = flows.filter(f => !(taxTrackerShown && f.flow_type === 'Tax Return'))

  // Team Access announcement is shown only to the account-admin (the only user
  // who can invite teammates). Same resolver the sidebar/layout uses.
  const canManageTeam = !!contactId && !!selectedAccountId
    ? await isAccountAdmin(contactId, selectedAccountId)
    : false

  // Fetch active portal announcements — graceful fallback if table missing
  let portalAnnouncements: PortalAnnouncement[] = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: annData } = await (supabaseAdmin as any)
      .from('portal_announcements')
      .select('id, title, message, title_en, message_en, type, dismissible')
      .eq('active', true)
      .order('created_at', { ascending: false })
    portalAnnouncements = (annData ?? []) as PortalAnnouncement[]
  } catch {
    // table doesn't exist yet — no banners shown
  }

  if (!account) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto text-center py-20">
        <p className="text-zinc-500">{t('dashboard.accountNotFound', locale)}</p>
      </div>
    )
  }
  const today = new Date().toISOString().split('T')[0]
  const allServices = services
  const isMultiMember = account.entity_type?.toLowerCase().includes('multi') || members.length > 1

  // PR 2 Step 4 — merge company-scoped + personal payments into one mixed
  // list with a per-row scope label, mirroring the Expenses tab on
  // /portal/invoices. Per Antonio's "he sees both" rule applied to the
  // home-page PaymentHistory widget for active-tier clients.
  const personalPaymentLabel = locale === 'it' ? 'Personale' : 'Personal'
  const companyPaymentLabel = account.company_name ?? (locale === 'it' ? 'Azienda' : 'Company')
  const payments = [
    ...accountPayments.map(p => ({ ...p, scope_label: companyPaymentLabel })),
    ...contactPayments.map(p => ({ ...p, scope_label: personalPaymentLabel })),
  ].sort((a, b) => {
    const ad = a.due_date ?? ''
    const bd = b.due_date ?? ''
    return bd.localeCompare(ad)
  })

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{account.company_name}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {account.entity_type && `${account.entity_type} \u2022 `}
          {account.state_of_formation && `${account.state_of_formation}`}
        </p>
      </div>

      {/* What's New - one-time (per device) feature announcement, dismissed via localStorage */}
      <WhatsNewBanner locale={locale} />

      {/* Offer banner — persistent until the offer is completed or expired */}
      {pendingOffer && (
        <OfferBanner
          offerUrl={`${APP_BASE_URL}/offer/${pendingOffer.token}`}
          locale={locale}
        />
      )}

      {/* Formation-in-progress banner removed (dev_task bb54680b): it was
          queried by email (not the selected company) and on a formation offer
          left at account_id NULL, so it leaked onto every active company's
          dashboard and lingered after the company was formed. The in-progress
          formation is now a first-class switchable entity — the company switcher
          lists it and selecting it renders the FormationDashboard (with the
          Continue-Setup CTA), which is the correct per-entity path. */}

      {/* Member info banner — urgent, shown for MMLLC clients with a pending member info request */}
      {pendingMemberInfoRequest && (
        <MemberInfoBanner
          formUrl={`${APP_BASE_URL}/member-info/${pendingMemberInfoRequest.token}/${pendingMemberInfoRequest.access_code}`}
          locale={locale}
        />
      )}

      {/* Renewal MSA banner — shown until the annual agreement is signed */}
      {renewalOffer && (
        <RenewalBanner token={renewalOffer.token} locale={locale} />
      )}

      {/* Relay Wire guide announcement — dismissible per device via localStorage */}
      <GuideAnnouncementBanner locale={locale} />

      {/* Team Access feature announcement — account-admins only, dismissible per device */}
      {canManageTeam && <TeamAccessAnnouncementBanner locale={locale} />}

      {/* DB-backed portal announcements — managed from CRM Config → Announcements */}
      <AnnouncementBanners announcements={portalAnnouncements} locale={locale} />

      {/* Profile completion banner — shown for standalone tax-return clients
          with missing contact fields (phone, address, DOB, citizenship). The
          component self-hides when dismissed for the session or when the
          contact has no missing fields. */}
      {profileBanner.shouldShow && contactId && (
        <ProfileCompletionBanner
          contactId={contactId}
          missingFields={profileBanner.missingFields}
          locale={locale}
        />
      )}

      {/* Tax Banner — pause banner renders ONLY when this specific SD is
          on_hold. The global tax_season_paused flag drives policy (new SDs
          get parked at creation, bulk-park operations flip existing ones),
          not UI rendering — otherwise One-Time standalone Tax Return
          clients (who are exempt from parking) would see a pause banner
          that doesn't apply to them, and their wizard would be unreachable. */}
      {taxReturns.filter(tr => {
        // Show banner for any in-flight return. Terminal statuses need no banner.
        // review_status drives the display; legacy data_received path is handled
        // inside TaxBanner as a fallback for pre-Slice-2 submissions.
        const TERMINAL = new Set(['TR Filed', 'TR Completed', 'Cancelled'])
        return !TERMINAL.has(tr.status ?? '')
      }).slice(0, 1).map(tr => {
        // Pause banner fires only when the SD is on_hold AND the tax_return
        // is at a pre-data-receipt status. Clients past "Data Received"
        // already submitted their data and are naturally gated by the 2nd
        // installment — pausing them is stale/misleading.
        // 'Activated - Need Link' and 'Link Sent - Awaiting Data' are LEGACY statuses
        // (old "email a data link, await data" flow, replaced by the wizard — no current
        // pipeline stage produces them). Kept here on purpose: both are pre-data-receipt,
        // so a row manually set to one still pauses correctly during a tax-season pause.
        // Do not remove. See docs/systems/tax-returns.md.
        const PAUSE_ELIGIBLE_TR_STATUS = new Set(['Activated - Need Link', 'Link Sent - Awaiting Data', 'Wizard Available', 'Extension Filed'])
        const isPaused = tr.sd_status === 'on_hold' && PAUSE_ELIGIBLE_TR_STATUS.has(tr.status ?? '')
        if (isPaused) {
          const firstName =
            (user.user_metadata?.full_name as string | undefined)?.split(' ')[0] ??
            null
          const deadlineIso = resolveExtensionDeadline(
            tr.extension_deadline,
            tr.tax_year,
            tr.return_type as Parameters<typeof resolveExtensionDeadline>[2],
          )
          const deadlineDisplay = deadlineIso
            ? formatDeadlineForDisplay(deadlineIso, locale)
            : null
          return (
            <TaxExtensionFiledBanner
              key={tr.id}
              firstName={firstName}
              confirmationId={tr.extension_submission_id ?? null}
              deadlineDisplay={deadlineDisplay}
              locale={locale}
            />
          )
        }
        return (
          <TaxBanner
            key={tr.id}
            taxYear={tr.tax_year}
            returnType={tr.return_type}
            locale={locale}
            reviewStatus={(tr.review_status as import('@/lib/tax/review-status').ReviewStatus | null) ?? undefined}
            submissionId={tr.submission_id ?? null}
            dataReceived={tr.data_received ?? false}
            sentToAccountant={tr.sent_to_accountant ?? false}
            showFinancialsLink={(tr.return_type === 'MMLLC' || tr.return_type === 'Corp') && tr.submission_id != null}
            sdStage={tr.sd_stage ?? null}
          />
        )
      })}

      {/* Tax progress tracker (Slice 5) — full client-facing journey, only
          rendered once the SD is at/past 1st Installment Paid. Catalog-driven:
          steps and labels come from pipeline_stages (client_label /
          client_label_it), so relabels need no deploy. */}
      {trackerSteps && trackerTr && (
        <TaxProgressTracker steps={trackerSteps} taxYear={trackerTr.tax_year} locale={locale} />
      )}

      {/* Service Status — a visual progress stepper per active recurring flow
          (Annual Report / RA Renewal / Tax Return when its dedicated tracker
          isn't already shown). Each flow renders its title ("Tax Return 2025"),
          a dot-per-stage stepper with the current stage highlighted, and the
          stage labels. Flows with no client-facing stages (CMRA) show a neutral
          "Active" card. Stage labels come from pipeline_stages client_label /
          client_label_it, so relabels need no deploy. */}
      {flowsForStatus.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-2 px-1">
            <ListChecks className="h-4 w-4 text-zinc-400" />
            {locale === 'it' ? 'Stato dei Servizi' : 'Service Status'}
          </h2>
          {flowsForStatus.map(f =>
            f.steps ? (
              <FlowProgressTracker key={f.id} title={f.title} steps={f.steps} href={`/portal/flows/${f.id}`} />
            ) : (
              <Link
                key={f.id}
                href={`/portal/flows/${f.id}`}
                className="bg-white rounded-xl border shadow-sm p-5 flex items-center justify-between gap-2 hover:border-zinc-300 transition-colors"
              >
                <span className="text-sm font-medium text-zinc-900">{f.title}</span>
                <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                  {locale === 'it' ? 'Attivo' : 'Active'}
                </span>
              </Link>
            )
          )}
        </div>
      )}

      {/* Action Items Widget */}
      <ActionItems data={actionItems} locale={locale} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Company Info Card */}
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('dashboard.companyInfo', locale)}</h2>
          <div className="space-y-2.5 text-sm">
            <InfoRow icon={Building2} label={t('dashboard.entityType', locale)} value={account.entity_type ?? '\u2014'} />
            <InfoRow icon={MapPin} label={t('dashboard.state', locale)} value={account.state_of_formation ?? '\u2014'} />
            <InfoRow icon={Calendar} label={t('dashboard.formation', locale)} value={formatDate(account.formation_date)} />
            <InfoRow icon={Shield} label={t('dashboard.ein', locale)} value={formatEin(account.ein_number)} />
            {account.filing_id && <InfoRow icon={FileText} label={t('profile.filingId', locale)} value={account.filing_id} />}
            {account.registered_agent_address && <InfoRow icon={MapPin} label={t('dashboard.raAddress', locale)} value={account.registered_agent_address} />}
            {account.physical_address && <InfoRow icon={MapPin} label={t('dashboard.address', locale)} value={account.physical_address} />}
          </div>
        </div>

        {/* Members Card — shown for multi-member LLCs or when multiple contacts */}
        {isMultiMember && members.length > 0 && (
          <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
              {t('dashboard.members', locale)} ({members.length})
            </h2>
            <div className="space-y-3">
              {members.map((m, i) => {
                const isCompany = m.member_type === 'company'
                const displayName = isCompany
                  ? (m.company_name ?? m.first_name)
                  : `${m.first_name} ${m.last_name}`.trim()
                const repLine = isCompany && m.representative_name ? `Rep: ${m.representative_name}` : null

                return (
                <div key={i} className="rounded-lg border p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isCompany
                        ? <Building2 className="h-4 w-4 text-zinc-400" />
                        : <User className="h-4 w-4 text-zinc-400" />
                      }
                      {m.member_id ? (
                        <Link
                          href={`/portal/members/${m.member_id}`}
                          className="text-sm font-medium text-blue-700 hover:underline flex items-center gap-1"
                        >
                          {displayName}
                          {m.is_primary && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-500 font-normal">Primary</span>}
                          <ChevronRight className="h-3 w-3 opacity-50" />
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-zinc-900">{displayName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 capitalize">{m.role}</span>
                      {m.ownership_pct != null && (
                        <span className="text-xs font-medium text-zinc-600">{m.ownership_pct}%</span>
                      )}
                    </div>
                  </div>
                  {repLine && (
                    <div className="text-xs text-zinc-500 pl-6">{repLine}</div>
                  )}
                  {m.email && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Mail className="h-3.5 w-3.5" />
                      <a href={`mailto:${m.email}`} className="hover:text-zinc-700">{m.email}</a>
                    </div>
                  )}
                  {m.phone && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Phone className="h-3.5 w-3.5" />
                      <a href={`tel:${m.phone}`} className="hover:text-zinc-700">{m.phone}</a>
                    </div>
                  )}
                </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Services Card */}
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            {t('dashboard.activeServices', locale)} ({allServices.length})
          </h2>
          {allServices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-400">
              <CheckCircle2 className="h-8 w-8 mb-2" />
              <p className="text-sm">{t('dashboard.noServices', locale)}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {allServices.map(s => (
                <div key={s.id} className={cn('rounded-lg border p-3', s.blocked_waiting_external && 'border-red-200 bg-red-50/50')}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium truncate">{s.service_name}</span>
                    <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[s.status ?? ''] ?? 'bg-zinc-100')}>
                      {s.status}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500">{s.service_type}</p>
                  {s.current_step != null && s.total_steps != null && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
                        <span>{t('dashboard.progress', locale)}</span>
                        <span>{s.current_step}/{s.total_steps}</span>
                      </div>
                      <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${Math.min((s.current_step / s.total_steps) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {s.current_stage && (
                    <p className="text-xs text-zinc-400 mt-1">{t('dashboard.stage', locale)}: {s.current_stage}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Partner Bank Applications — external apply links (Sokin, etc.) */}
        {bankReferrals.length > 0 && (
          <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
              {locale === 'it' ? 'Banche Partner' : 'Partner Banks'}
            </h2>
            <p className="text-xs text-zinc-500">
              {locale === 'it'
                ? 'Clicca per candidarti direttamente presso le nostre banche partner.'
                : 'Click to apply directly at our partner banks.'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {bankReferrals.map(b => (
                <a
                  key={b.slug}
                  href={`/portal/apply/bank/${b.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border p-3 transition-colors',
                    b.clicked_at
                      ? 'border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/60'
                      : 'border-zinc-200 bg-white hover:border-blue-300 hover:bg-blue-50/30'
                  )}
                >
                  <span className="text-sm font-medium">{b.label}</span>
                  <span className={cn(
                    'text-[10px] px-2 py-0.5 rounded-full font-medium',
                    b.clicked_at ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                  )}>
                    {b.clicked_at
                      ? (locale === 'it' ? 'Aperto' : 'Opened')
                      : (locale === 'it' ? 'Candidati →' : 'Apply →')}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Upcoming Deadlines */}
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('dashboard.upcomingDeadlines', locale)}</h2>
          {deadlines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-400">
              <Calendar className="h-8 w-8 mb-2" />
              <p className="text-sm">{t('dashboard.noDeadlines', locale)}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {deadlines.map(d => {
                const daysUntil = differenceInDays(parseISO(d.due_date), parseISO(today))
                const isOverdue = daysUntil < 0
                return (
                  <div key={d.id} className={cn(
                    'flex items-center gap-3 p-2.5 rounded-lg text-sm',
                    isOverdue ? 'bg-red-50' : daysUntil <= 7 ? 'bg-orange-50' : 'bg-yellow-50'
                  )}>
                    <Clock className={cn('h-4 w-4 shrink-0', isOverdue ? 'text-red-500' : 'text-orange-500')} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate text-xs">{d.deadline_type}</p>
                      <p className="text-xs text-zinc-500">{formatDate(d.due_date)}</p>
                    </div>
                    <span className={cn('text-xs font-medium', isOverdue ? 'text-red-600' : 'text-orange-600')}>
                      {isOverdue ? `${Math.abs(daysUntil)}d overdue` : daysUntil === 0 ? 'Today' : `${daysUntil}d`}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Payment History */}
        <PaymentHistory payments={payments} title={t('dashboard.paymentHistory', locale)} />

        {/* Tax Returns */}
        {taxReturns.length > 0 && (
          <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3 lg:col-span-2">
            <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('dashboard.taxReturns', locale)}</h2>
            <div className="space-y-2">
              {taxReturns.map(tr => (
                <div key={tr.id} className="flex flex-col sm:flex-row sm:items-center justify-between py-2 border-b last:border-b-0 text-sm gap-1 sm:gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{tr.tax_year}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">{tr.return_type}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                    <span className="text-xs text-zinc-500">{t('dashboard.deadline', locale)}: {formatDate(tr.deadline)}</span>
                    {tr.extension_filed && (() => {
                      const resolvedIso = resolveExtensionDeadline(
                        tr.extension_deadline,
                        tr.tax_year,
                        tr.return_type as Parameters<typeof resolveExtensionDeadline>[2],
                      )
                      const displayed = resolvedIso ? formatDeadlineForDisplay(resolvedIso, locale) : '\u2014'
                      return (
                        <span className="text-xs text-zinc-500">
                          {t('dashboard.ext', locale)}: {displayed}
                        </span>
                      )
                    })()}
                    <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[tr.status ?? ''] ?? 'bg-zinc-100')}>
                      {tr.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start sm:items-center gap-2">
      <Icon className="h-4 w-4 text-zinc-400 shrink-0 mt-0.5 sm:mt-0" />
      <div className="flex flex-col sm:flex-row sm:gap-2 min-w-0">
        <span className="text-zinc-500 text-xs sm:text-sm sm:min-w-[110px] shrink-0">{label}</span>
        <span className="font-medium text-zinc-900 text-sm break-words">{value}</span>
      </div>
    </div>
  )
}
