export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalServices, getPortalDeadlines, getPortalPayments, getPortalTaxReturns, getPortalMembers, getPortalTier, getPortalActionItems } from '@/lib/portal/queries'
import { ActionItems } from '@/components/portal/action-items'
import { Building2, Shield, MapPin, Calendar, FileText, Clock, CheckCircle2, CreditCard, Mail, Phone, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { WelcomeDashboard } from './welcome-dashboard'
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

function formatCurrency(amount: number | null, currency?: string | null): string {
  if (amount == null) return '\u2014'
  const c = currency === 'EUR' ? '\u20AC' : '$'
  return `${c}${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const STATUS_COLORS: Record<string, string> = {
  'Not Started': 'bg-zinc-100 text-zinc-600',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Waiting Client': 'bg-amber-100 text-amber-700',
  'Waiting Third Party': 'bg-orange-100 text-orange-700',
  'Completed': 'bg-emerald-100 text-emerald-700',
  'Cancelled': 'bg-zinc-100 text-zinc-500',
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

    return (
      <WelcomeDashboard
        tier={authTier}
        firstName={firstName}
        offerData={offerData}
        locale={locale}
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

    return (
      <WelcomeDashboard
        tier={portalTier}
        firstName={firstName}
        offerData={offerData}
        locale={locale}
      />
    )
  }

  // Fetch all data in parallel
  const [account, services, deadlines, payments, taxReturns, members, actionItems] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalServices(selectedAccountId),
    getPortalDeadlines(selectedAccountId),
    getPortalPayments(selectedAccountId),
    getPortalTaxReturns(selectedAccountId),
    getPortalMembers(selectedAccountId),
    getPortalActionItems(selectedAccountId, contactId || undefined),
  ])

  if (!account) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto text-center py-20">
        <p className="text-zinc-500">{t('dashboard.accountNotFound', locale)}</p>
      </div>
    )
  }
  const today = new Date().toISOString().split('T')[0]
  const activeServices = services.filter(s => s.status !== 'Completed')
  const _completedServices = services.filter(s => s.status === 'Completed')
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
              {members.map((m, i) => (
                <div key={i} className="rounded-lg border p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-zinc-400" />
                      <span className="text-sm font-medium text-zinc-900">{m.first_name} {m.last_name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{m.role}</span>
                      {m.ownership_pct != null && (
                        <span className="text-xs text-zinc-500">{m.ownership_pct}%</span>
                      )}
                    </div>
                  </div>
                  {m.email && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Mail className="h-3.5 w-3.5" />
                      <span>{m.email}</span>
                    </div>
                  )}
                  {m.phone && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Phone className="h-3.5 w-3.5" />
                      <span>{m.phone}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Active Services Card */}
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            {t('dashboard.activeServices', locale)} ({activeServices.length})
          </h2>
          {activeServices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-400">
              <CheckCircle2 className="h-8 w-8 mb-2" />
              <p className="text-sm">{t('dashboard.noServices', locale)}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activeServices.map(s => (
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
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('dashboard.paymentHistory', locale)}</h2>
          {payments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-400">
              <CreditCard className="h-8 w-8 mb-2" />
              <p className="text-sm">{t('dashboard.noPayments', locale)}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {payments.slice(0, 8).map(p => (
                <div key={p.id} className="flex items-center justify-between py-2 border-b last:border-b-0 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate text-xs">{p.description ?? (`${p.period ?? ''} ${p.year ?? ''}`.trim() || '\u2014')}</p>
                    <p className="text-xs text-zinc-500">{p.due_date ? formatDate(p.due_date) : '\u2014'}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[p.status ?? ''] ?? 'bg-zinc-100')}>
                      {p.status}
                    </span>
                    <span className="text-xs font-medium">{formatCurrency(p.amount, p.amount_currency)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

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
                    {tr.extension_filed && (
                      <span className="text-xs text-zinc-500">{t('dashboard.ext', locale)}: {formatDate(tr.extension_deadline)}</span>
                    )}
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
