import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { SERVICE_TRACKER_SLUGS, SERVICE_TYPE_TO_SLUG } from '@/lib/constants'
import {
  Building, UserPlus, FileText, CreditCard, Landmark,
  XCircle, Hash, CalendarDays, Shield, Mail, Receipt,
} from 'lucide-react'

const ICONS: Record<string, React.ElementType> = {
  'Company Formation': Building,
  'Client Onboarding': UserPlus,
  'Tax Return': FileText,
  'ITIN': CreditCard,
  'Banking Fintech': Landmark,
  'Company Closure': XCircle,
  'EIN': Hash,
  'State Annual Report': CalendarDays,
  'State RA Renewal': Shield,
  'CMRA Mailing Address': Mail,
  'Billing Annual Renewal': Receipt,
}

export default async function TrackersIndexPage() {
  const supabase = createClient()

  // Get counts per service type
  const { data: deliveries } = await supabase
    .from('service_deliveries')
    .select('service_type, status')

  // Aggregate
  const typeCounts: Record<string, { active: number; completed: number; total: number }> = {}
  for (const d of deliveries ?? []) {
    const t = d.service_type
    if (!t) continue
    if (!typeCounts[t]) typeCounts[t] = { active: 0, completed: 0, total: 0 }
    typeCounts[t].total++
    if (d.status === 'active') typeCounts[t].active++
    if (d.status === 'completed') typeCounts[t].completed++
  }

  // Build cards for all known service types
  const serviceTypes = Object.entries(SERVICE_TRACKER_SLUGS)
    .map(([slug, serviceType]) => ({
      slug,
      serviceType,
      active: typeCounts[serviceType]?.active ?? 0,
      completed: typeCounts[serviceType]?.completed ?? 0,
      total: typeCounts[serviceType]?.total ?? 0,
      Icon: ICONS[serviceType] ?? FileText,
    }))
    .sort((a, b) => b.active - a.active) // Most active first

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Service Trackers</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Track service delivery pipelines by type
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {serviceTypes.map(({ slug, serviceType, active, completed, total, Icon }) => (
          <Link
            key={slug}
            href={`/trackers/${slug}`}
            className="bg-white rounded-xl border p-5 hover:shadow-md hover:border-blue-200 transition-all group"
          >
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-blue-50 text-blue-600 group-hover:bg-blue-100 transition-colors">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold truncate">{serviceType}</h3>
                <div className="flex items-center gap-3 mt-2">
                  {active > 0 && (
                    <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                      {active} active
                    </span>
                  )}
                  {completed > 0 && (
                    <span className="text-xs text-zinc-500">
                      {completed} done
                    </span>
                  )}
                  {total === 0 && (
                    <span className="text-xs text-zinc-400">No deliveries</span>
                  )}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
