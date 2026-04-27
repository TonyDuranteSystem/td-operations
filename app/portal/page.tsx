export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalServices, getPortalDeadlines, getPortalPayments, getPortalTaxReturns, getPortalMembers, getPortalTier, getPortalActionItems, getProfileBannerStatus, getFormationAccount } from '@/lib/portal/queries'
import { ActionItems } from '@/components/portal/action-items'
import { Building2, Shield, MapPin, Calendar, FileText, Clock, CheckCircle2, Mail, Phone, User, ChevronRight } from 'lucide-react'
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
import { ProfileCompletionBanner } from '@/components/portal/profile-completion-banner'
import { resolveExtensionDeadline, formatDeadlineForDisplay } from '@/lib/tax/extension-deadline'
import { differenceInDays, parseISO, format } from 'date-fns'

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

  // Get accounts (may be empty for leads)
  const accounts = contactId ? await getPortalAccounts(contactId) : []

  // Get selected account
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.length > 0
    ? (accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0].id)
    : ''

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

    // Formation tier with no Active/Suspended account: the client has a
    // 'Pending Formation' account (excluded from getPortalAccounts) — render
    // the formation-specific dashboard with full progress tracking.
    if (authTier === 'formation' && contactId) {
      const formationAccount = await getFormationAccount(contactId)
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
        return (
          <FormationDashboard
            firstName={firstName}
            locale={locale}
            account={formationAccount}
            wizardData={wizardRes.data}
            ss4Data={ss4Res.data}
            oaData={oaRes.data}
            leaseData={leaseRes.data}
          />
        )
      }
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

    return (
      <WelcomeDashboard
        tier={authTier}
        firstName={firstName}
        offerData={offerData}
        locale={locale}
        wizardSubmitted={wizardSubmitted}
      />
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
    return (
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
      />
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

  // Fetch all data in parallel
  const [account, services, deadlines, payments, taxReturns, members, actionItems, profileBanner] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalServices(selectedAccountId),
    getPortalDeadlines(selectedAccountId),
    getPortalPayments(selectedAccountId),
    getPortalTaxReturns(selectedAccountId),
    getPortalMembers(selectedAccountId),
    getPortalActionItems(selectedAccountId, contactId || undefined),
    contactId ? getProfileBannerStatus(contactId) : Promise.resolve({ shouldShow: false, missingFields: [] as string[] }),
  ])
  // Partner-bank referrals — separate await because the generated Supabase
  // types don't yet cover bank_referrals/bank_referral_clicks. The helper
  // in lib/bank-referrals.ts swallows errors so a missing schema in any
  // environment just renders an empty "Partner Banks" section.
  const bankReferrals = await getBankReferralsForAccount(selectedAccountId)

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

      {/* Relay Wire guide announcement — dismissible per device via localStorage */}
      <GuideAnnouncementBanner locale={locale} />

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
      {taxReturns.filter(tr => tr.status !== 'TR Filed').slice(0, 1).map(tr => {
        // Pause banner fires only when the SD is on_hold AND the tax_return
        // is at a pre-data-receipt status. Clients past "Data Received"
        // already submitted their data and are naturally gated by the 2nd
        // installment — pausing them is stale/misleading.
        const PAUSE_ELIGIBLE_TR_STATUS = new Set(['Activated - Need Link', 'Link Sent - Awaiting Data', 'Extension Filed'])
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
            dataReceived={tr.data_received ?? false}
            sentToIndia={tr.sent_to_india ?? false}
          />
        )
      })}

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
                      {m.contact_id ? (
                        <Link
                          href={`/portal/members/${m.contact_id}`}
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
