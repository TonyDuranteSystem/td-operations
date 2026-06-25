import Link from 'next/link'
import { UserCheck, ArrowRight } from 'lucide-react'

/**
 * Prominent, top-of-page banner linking to an ITIN flow Workspace. Mirrors
 * FormationWorkspaceBanner (Company Formation) for ITIN, which is contact-scoped
 * (account_id NULL), so it's shown on the CRM contact page when the contact has
 * an active ITIN service delivery. It's a priority CTA — staff drive the whole
 * ITIN application from the workspace — so it sits near the top, not in a tab.
 * Plain server component (just a Link + markup).
 */
export function ItinWorkspaceBanner({
  serviceDeliveryId,
  stage,
}: {
  serviceDeliveryId: string
  stage?: string | null
}) {
  return (
    <Link
      href={`/flows/${serviceDeliveryId}`}
      className="group mb-4 flex items-center gap-4 rounded-xl border-2 border-teal-300 bg-teal-50 p-4 transition-colors hover:bg-teal-100"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-600">
        <UserCheck className="h-6 w-6 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-teal-900">ITIN application in progress</p>
        <p className="mt-0.5 text-sm text-teal-700">
          {stage ? `Current stage: ${stage}` : 'Open the ITIN workspace'}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white">
        Open workspace
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
