import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalServices, getPortalDeadlines, getPortalPayments, getPortalTaxReturns } from '@/lib/portal/queries'
import { Building2, Shield, MapPin, Calendar, FileText, Clock, AlertCircle, CheckCircle2, CreditCard } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
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
  if (!contactId) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl mx-auto text-center py-20">
        <p className="text-zinc-500">No company linked to your account. Please contact support.</p>
      </div>
    )
  }

  const accounts = await getPortalAccounts(contactId)
  if (accounts.length === 0) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl mx-auto text-center py-20">
        <p className="text-zinc-500">No active companies found. Please contact support.</p>
      </div>
    )
  }

  // Get selected account
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0].id

  // Fetch all data in parallel
  const [account, services, deadlines, payments, taxReturns] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalServices(selectedAccountId),
    getPortalDeadlines(selectedAccountId),
    getPortalPayments(selectedAccountId),
    getPortalTaxReturns(selectedAccountId),
  ])

  if (!account) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl mx-auto text-center py-20">
        <p className="text-zinc-500">Account not found.</p>
      </div>
    )
  }

  const locale = getLocale(user)
  const today = new Date().toISOString().split('T')[0]
  const activeServices = services.filter(s => s.status !== 'Completed')
  const completedServices = services.filter(s => s.status === 'Completed')

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{account.company_name}</h1>
        <p className="text-zinc-500 text-sm mt-1">
          {account.entity_type && `${account.entity_type} \u2022 `}
          {account.state_of_formation && `${account.state_of_formation}`}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Company Info Card */}
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('dashboard.companyInfo', locale)}</h2>
          <div className="space-y-2.5 text-sm">
            <InfoRow icon={Building2} label="Entity Type" value={account.entity_type ?? '\u2014'} />
            <InfoRow icon={MapPin} label="State" value={account.state_of_formation ?? '\u2014'} />
            <InfoRow icon={Calendar} label="Formation" value={formatDate(account.formation_date)} />
            <InfoRow icon={Shield} label="EIN" value={formatEin(account.ein_number)} />
            {account.filing_id && <InfoRow icon={FileText} label="Filing ID" value={account.filing_id} />}
            {account.registered_agent_provider && <InfoRow icon={Shield} label="Registered Agent" value={account.registered_agent_provider} />}
            {account.physical_address && <InfoRow icon={MapPin} label="Address" value={account.physical_address} />}
          </div>
        </div>

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
                    <p className="text-xs text-zinc-400 mt-1">Stage: {s.current_stage}</p>
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
                <div key={tr.id} className="flex items-center justify-between py-2 border-b last:border-b-0 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{tr.tax_year}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">{tr.return_type}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500">Deadline: {formatDate(tr.deadline)}</span>
                    {tr.extension_filed && (
                      <span className="text-xs text-zinc-500">Ext: {formatDate(tr.extension_deadline)}</span>
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
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
      <span className="text-zinc-500 min-w-[110px]">{label}</span>
      <span className="font-medium text-zinc-900">{value}</span>
    </div>
  )
}
