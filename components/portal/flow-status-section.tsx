import Link from 'next/link'
import { ListChecks } from 'lucide-react'
import { FlowProgressTracker } from '@/components/portal/flow-progress-tracker'
import type { PortalFlow } from '@/lib/portal/queries'
import { t, type Locale } from '@/lib/portal/i18n'

/**
 * "Service Status" section — a visual progress stepper per active flow. Extracted
 * so it can render BOTH on the standard active-tier dashboard and ALONGSIDE the
 * FormationDashboard (so a formation-tier client who also has an ITIN can still
 * see and open it — without it the page returns FormationDashboard early and the
 * ITIN flow is invisible). Server component; FlowProgressTracker is the client
 * child. Renders nothing when there are no flows.
 */
export function PortalFlowStatusSection({
  flows,
  locale,
  translations = {},
}: {
  flows: PortalFlow[]
  locale: Locale
  translations?: Record<string, string>
}) {
  if (flows.length === 0) return null

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-2 px-1">
        <ListChecks className="h-4 w-4 text-zinc-400" />
        {t('flows.serviceStatus', locale, translations)}
      </h2>
      {flows.map(f =>
        f.steps ? (
          <FlowProgressTracker key={f.id} title={f.title} steps={f.steps} href={`/portal/flows/${f.id}`} isNew={f.isNew} />
        ) : (
          <Link
            key={f.id}
            href={`/portal/flows/${f.id}`}
            className="bg-white rounded-xl border shadow-sm p-5 flex items-center justify-between gap-2 hover:border-zinc-300 transition-colors"
          >
            <span className="text-sm font-medium text-zinc-900 flex items-center gap-2">
              {f.title}
              {f.isNew && (
                <span className="h-5 px-2 inline-flex items-center justify-center rounded-full bg-violet-600 text-white text-[10px] font-semibold">
                  {t('flows.new', locale, translations)}
                </span>
              )}
            </span>
            <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
              {t('flows.active', locale, translations)}
            </span>
          </Link>
        )
      )}
    </div>
  )
}
