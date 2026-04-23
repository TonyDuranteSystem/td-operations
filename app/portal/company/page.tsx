export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import {
  getPortalAccounts,
  getPortalAccountDetail,
  getPortalServices,
  getPortalDeadlines,
} from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { t, getLocale } from '@/lib/portal/i18n'
import { Briefcase, CalendarDays, Activity, CheckCircle2, Clock, ChevronRight, Building2, Hash, MapPin } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  'Not Started': 'bg-zinc-100 text-zinc-600',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Waiting Client': 'bg-amber-100 text-amber-700',
  'Waiting Third Party': 'bg-orange-100 text-orange-700',
  'Completed': 'bg-emerald-100 text-emerald-700',
  'Cancelled': 'bg-zinc-100 text-zinc-500',
}

const DEADLINE_STATUS_COLORS: Record<string, string> = {
  'Pending': 'bg-amber-100 text-amber-700',
  'Overdue': 'bg-red-100 text-red-700',
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default async function MyCompanyPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id

  const locale = getLocale(user)

  if (!selectedAccountId) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Briefcase className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">No company found</h3>
          <p className="text-sm text-zinc-500">Contact us if you need assistance.</p>
        </div>
      </div>
    )
  }

  const [detail, services, deadlines] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalServices(selectedAccountId),
    getPortalDeadlines(selectedAccountId),
  ])

  const activeServices = services.filter(s => s.status !== 'Completed' && s.status !== 'Cancelled')
  const completedServices = services.filter(s => s.status === 'Completed')

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
          {t('company.title', locale)}
        </h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {t('company.subtitle', locale)}
        </p>
      </div>

      {/* Company Info Card */}
      {detail && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b bg-zinc-50">
            <Building2 className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-semibold text-zinc-800">{t('company.info', locale)}</span>
          </div>
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {detail.company_name && (
              <div>
                <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide mb-1">{t('company.name', locale)}</p>
                <p className="text-sm font-semibold text-zinc-900">{detail.company_name}</p>
              </div>
            )}
            {detail.entity_type && (
              <div>
                <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide mb-1">{t('company.entityType', locale)}</p>
                <p className="text-sm text-zinc-700">{detail.entity_type}</p>
              </div>
            )}
            {detail.ein_number && (
              <div className="flex items-start gap-2">
                <Hash className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide mb-1">{t('company.ein', locale)}</p>
                  <p className="text-sm font-mono text-zinc-700">{detail.ein_number}</p>
                </div>
              </div>
            )}
            {detail.state_of_formation && (
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide mb-1">{t('company.state', locale)}</p>
                  <p className="text-sm text-zinc-700">{detail.state_of_formation}</p>
                </div>
              </div>
            )}
            {detail.formation_date && (
              <div>
                <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide mb-1">{t('company.formed', locale)}</p>
                <p className="text-sm text-zinc-700">{formatDate(detail.formation_date)}</p>
              </div>
            )}
            {detail.registered_agent_provider && (
              <div>
                <p className="text-xs text-zinc-400 font-medium uppercase tracking-wide mb-1">{t('company.registeredAgent', locale)}</p>
                <p className="text-sm text-zinc-700">{detail.registered_agent_provider}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upcoming Deadlines */}
      {deadlines.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-zinc-50">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-zinc-500" />
              <span className="text-sm font-semibold text-zinc-800">{t('company.upcomingDeadlines', locale)}</span>
            </div>
            <Link href="/portal/deadlines" className="text-xs text-blue-600 hover:text-blue-800 font-medium">
              {t('common.viewAll', locale)} <ChevronRight className="inline h-3 w-3" />
            </Link>
          </div>
          <div className="divide-y">
            {deadlines.slice(0, 5).map(deadline => (
              <div key={deadline.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{deadline.deadline_type}</p>
                  {deadline.notes && (
                    <p className="text-xs text-zinc-500 mt-0.5">{deadline.notes}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-4">
                  <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', DEADLINE_STATUS_COLORS[deadline.status] ?? 'bg-zinc-100 text-zinc-600')}>
                    {deadline.status}
                  </span>
                  <span className="text-xs text-zinc-500 whitespace-nowrap">{formatDate(deadline.due_date)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Services */}
      {activeServices.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b bg-zinc-50">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-zinc-500" />
              <span className="text-sm font-semibold text-zinc-800">{t('company.activeServices', locale)}</span>
            </div>
            <Link href="/portal/services" className="text-xs text-blue-600 hover:text-blue-800 font-medium">
              {t('common.viewAll', locale)} <ChevronRight className="inline h-3 w-3" />
            </Link>
          </div>
          <div className="divide-y">
            {activeServices.map(service => (
              <div key={service.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{service.service_name}</p>
                  {service.current_stage && (
                    <p className="text-xs text-zinc-500 mt-0.5">{service.current_stage}</p>
                  )}
                </div>
                <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ml-4', STATUS_COLORS[service.status] ?? 'bg-zinc-100 text-zinc-600')}>
                  {service.status === 'In Progress' ? <Activity className="h-3 w-3 mr-1" /> : <Clock className="h-3 w-3 mr-1" />}
                  {service.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed Services */}
      {completedServices.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b bg-zinc-50">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span className="text-sm font-semibold text-zinc-800">{t('company.completedServices', locale)}</span>
          </div>
          <div className="divide-y">
            {completedServices.map(service => (
              <div key={service.id} className="flex items-center justify-between px-5 py-3">
                <p className="text-sm text-zinc-600">{service.service_name}</p>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 shrink-0 ml-4">
                  <CheckCircle2 className="h-3 w-3" />
                  Completed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!detail && activeServices.length === 0 && deadlines.length === 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Briefcase className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('company.noData', locale)}</h3>
          <p className="text-sm text-zinc-500">{t('company.noDataDesc', locale)}</p>
        </div>
      )}
    </div>
  )
}
