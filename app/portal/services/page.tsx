export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalServices } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { cn } from '@/lib/utils'
import { t, getLocale } from '@/lib/portal/i18n'
import { Activity, CheckCircle2, AlertCircle, Clock, Cog, ChevronRight } from 'lucide-react'
import Link from 'next/link'

const STATUS_COLORS: Record<string, string> = {
  'Not Started': 'bg-zinc-100 text-zinc-600',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Waiting Client': 'bg-amber-100 text-amber-700',
  'Waiting Third Party': 'bg-orange-100 text-orange-700',
  'Completed': 'bg-emerald-100 text-emerald-700',
  'Cancelled': 'bg-zinc-100 text-zinc-500',
}

const STATUS_ICONS: Record<string, React.ElementType> = {
  'Not Started': Clock,
  'In Progress': Activity,
  'Waiting Client': AlertCircle,
  'Waiting Third Party': AlertCircle,
  'Completed': CheckCircle2,
  'Cancelled': Clock,
}

export default async function PortalServicesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  if (!selectedAccountId) redirect('/portal')

  const locale = getLocale(user)
  const services = await getPortalServices(selectedAccountId)
  const active = services.filter(s => s.status !== 'Completed')
  const completed = services.filter(s => s.status === 'Completed')

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('services.title', locale)}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('services.subtitle', locale)}</p>
      </div>

      {services.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Cog className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('services.noServices', locale)}</h3>
          <p className="text-sm text-zinc-500">{t('services.noServicesDesc', locale)}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active */}
          {active.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('services.active', locale)} ({active.length})</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {active.map(s => {
                  const Icon = STATUS_ICONS[s.status ?? ''] ?? Activity
                  const progress = s.current_step && s.total_steps ? (s.current_step / s.total_steps) * 100 : 0
                  return (
                    <Link href={`/portal/services/${s.id}`} key={s.id} className={cn(
                      'bg-white rounded-xl border shadow-sm p-5 hover:shadow-md transition-shadow block',
                      s.blocked_waiting_external && 'border-red-200'
                    )}>
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2">
                          <Icon className={cn('h-5 w-5', s.status === 'Blocked' ? 'text-red-500' : 'text-blue-500')} />
                          <div>
                            <p className="font-medium text-sm text-zinc-900">{s.service_name}</p>
                            <p className="text-xs text-zinc-500">{s.service_type}</p>
                          </div>
                        </div>
                        <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[s.status ?? ''] ?? 'bg-zinc-100')}>
                          {s.status}
                        </span>
                      </div>

                      {s.current_step != null && s.total_steps != null && (
                        <div className="mb-2">
                          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1.5">
                            <span>{t('services.step', locale)} {s.current_step} {t('services.of', locale)} {s.total_steps}</span>
                            <span>{Math.round(progress)}%</span>
                          </div>
                          <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
                            <div
                              className={cn('h-full rounded-full transition-all', s.status === 'Blocked' ? 'bg-red-400' : 'bg-blue-500')}
                              style={{ width: `${Math.min(progress, 100)}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {s.current_stage && (
                        <p className="text-xs text-zinc-500 mt-2">{t('services.currentStage', locale)}: <span className="font-medium">{s.current_stage}</span></p>
                      )}

                      {s.blocked_waiting_external && s.blocked_reason && (
                        <div className="mt-2 p-2 rounded-lg bg-red-50 text-xs text-red-700">
                          <span className="font-medium">{t('services.blocked', locale)}:</span> {s.blocked_reason}
                        </div>
                      )}

                      <div className="mt-3 flex items-center text-xs text-blue-600 font-medium">
                        {t('services.viewDetails', locale)} <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )}

          {/* Completed */}
          {completed.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{t('services.completed', locale)} ({completed.length})</h2>
              <div className="grid gap-2">
                {completed.map(s => (
                  <Link href={`/portal/services/${s.id}`} key={s.id} className="bg-white rounded-xl border shadow-sm p-4 flex items-center gap-3 hover:shadow-md transition-shadow">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 truncate">{s.service_name}</p>
                      <p className="text-xs text-zinc-500">{s.service_type}</p>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">{t('services.completed', locale)}</span>
                    <ChevronRight className="h-4 w-4 text-zinc-300" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
